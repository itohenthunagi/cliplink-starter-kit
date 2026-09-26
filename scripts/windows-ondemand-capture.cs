using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net.Http;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

// 撮影・録画・管理画面を開く処理。常駐プログラム(windows-trigger.cs)へ組み込まれ、ショートカットキーと
// 通知領域アイコンから呼ばれる。スタートメニューの「Cliplink」(windows-ondemand-capture.ps1 -Mode Open)からも使う。
// アップロード・共有URL検証・クリップボードコピー・ブラウザ起動は windows-hotkey.cs の CliplinkUpload を再利用する。

// 何が起きたかを後から確かめられるよう、repo の .cliplink/capture.log に1行ずつ残す（秘密値は書かない）。
// 常駐プログラムの起動・異常終了もここへ書く。撮影と管理画面は同時に走り得るため、書込みは直列化する。
public static class CliplinkLog
{
    private static readonly object gate = new object();
    private static string path;

    // repoが見つからない（テストの架空パス等）ときは記録先を変えない。
    public static void Use(string repoRoot)
    {
        if (String.IsNullOrWhiteSpace(repoRoot) || !Directory.Exists(repoRoot)) return;
        try
        {
            string stateDir = Path.Combine(repoRoot, ".cliplink");
            Directory.CreateDirectory(stateDir);
            path = Path.Combine(stateDir, "capture.log");
        }
        catch (Exception) { path = null; }
    }

    public static void Write(string line)
    {
        if (path == null) return;
        try
        {
            lock (gate) File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine);
        }
        catch (Exception) { /* 記録の失敗で撮影・常駐を止めない */ }
    }
}

public static class CliplinkOnDemandCapture
{
    private static void Report(string line)
    {
        Console.WriteLine(line);
        CliplinkLog.Write(line);
    }

    // 失敗を黙って終わらせない。撮影をやめた(3)・二重起動(2)以外の失敗だけ知らせる。
    private static readonly string[] FailureMessages =
    {
        null, null, null, null,
        "録画ファイルが100MBを超えたため共有できませんでした。短めに録画してください。",
        "録画の保存先が見つかりませんでした。Snipping Toolで録画を停止したか確認してください。",
        "Cliplinkへの登録に失敗しました。通信やDropboxの状態を確認して、もう一度お試しください。",
        "共有URLを受け取れませんでした。もう一度お試しください。",
        "Cliplinkのサーバーを起動できませんでした。",
        "登録の途中でエラーが起きました。もう一度お試しください。",
    };
    private static void NotifyFailure(int code)
    {
        if (code < 0 || code >= FailureMessages.Length || FailureMessages[code] == null) return;
        if (Environment.GetEnvironmentVariable("CLIPLINK_NO_DIALOG") == "1") return;
        RunOnSta(() => MessageBox.Show(FailureMessages[code] + "\n\n記録: .cliplink\\capture.log", "Cliplink", MessageBoxButtons.OK, MessageBoxIcon.Warning));
    }

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    private const string ProductionGuard = "Global\\CliplinkOnDemand";
    private const byte KeyS = 0x53;
    private const byte KeyR = 0x52;
    private const byte VkShift = 0x10;
    private const byte VkControl = 0x11;
    private const byte VkMenu = 0x12; // Alt
    private const byte VkLWin = 0x5B;
    // 録画待機中、この間隔でNodeへ生存確認のGETを送りアイドルタイマーを延長する(既定5分の半分未満)。
    private static readonly TimeSpan VideoHeartbeatInterval = TimeSpan.FromSeconds(60);
    // Snipping ToolのTempStateファイルは録画停止直後にも確定処理が残る可能性があるため、
    // 連続スキャンだけでなく一定時間の静止も要求する。
    private const int VideoStableScansRequired = 5;
    private static readonly TimeSpan VideoSettleDelay = TimeSpan.FromSeconds(5);
    private const long VideoMaxBytes = 100L * 1024L * 1024L;

    public static int ParseIdleTimeoutMs(string raw, int fallbackMs)
    {
        int value;
        if (!String.IsNullOrWhiteSpace(raw) && int.TryParse(raw, out value) && value > 0) return value;
        return fallbackMs;
    }

    // async/awaitの継続はThreadPool(MTA)へ戻り得るため、Clipboard操作はこのSTAスレッド上で行う。
    private static T RunOnSta<T>(Func<T> action)
    {
        T result = default(T);
        ExceptionDispatchInfo captured = null;
        Thread thread = new Thread(() =>
        {
            try { result = action(); }
            catch (Exception ex) { captured = ExceptionDispatchInfo.Capture(ex); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (captured != null) captured.Throw();
        return result;
    }

    public static async Task<OnDemandSessionInfo> FetchSessionAsync(string origin, int timeoutMs)
    {
        try
        {
            using (HttpClient client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(timeoutMs) })
            {
                HttpResponseMessage response = await client.GetAsync(origin.TrimEnd('/') + "/api/session");
                if (!response.IsSuccessStatusCode) return null;
                string body = await response.Content.ReadAsStringAsync();
                Match tokenMatch = Regex.Match(body, "\"token\"\\s*:\\s*\"([0-9a-fA-F-]{36})\"");
                if (!tokenMatch.Success) return null;
                // shareBaseは/api/sessionを正本にする。cloudモードではgatewayのURLになるため、
                // 欠落・不正時にoriginへ推測フォールバックするとcloud共有URLの検証(CliplinkUpload.IsValidShareUrl)が
                // ローカルoriginを基準に誤判定する。フォールバックせずfail closed(セッション未検出扱い)にする。
                Match shareBaseMatch = Regex.Match(body, "\"shareBase\"\\s*:\\s*\"([^\"]*)\"");
                if (!shareBaseMatch.Success) return null;
                string shareBase = shareBaseMatch.Groups[1].Value;
                Uri shareBaseUri;
                if (String.IsNullOrWhiteSpace(shareBase) ||
                    !Uri.TryCreate(shareBase, UriKind.Absolute, out shareBaseUri) ||
                    (shareBaseUri.Scheme != Uri.UriSchemeHttp && shareBaseUri.Scheme != Uri.UriSchemeHttps))
                    return null;
                return new OnDemandSessionInfo(tokenMatch.Groups[1].Value, shareBase);
            }
        }
        catch (Exception) { return null; }
    }

    public static async Task<OnDemandSessionInfo> WaitForSessionAsync(string origin, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            OnDemandSessionInfo session = await FetchSessionAsync(origin, 800);
            if (session != null) return session;
            await Task.Delay(500);
        }
        return null;
    }

    private static async Task SendHeartbeatAsync(string origin)
    {
        try
        {
            using (HttpClient client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) })
                await client.GetAsync(origin.TrimEnd('/') + "/api/session");
        }
        catch (Exception) { /* 心拍の失敗で録画待機を止めない */ }
    }

    public static bool IsListening(string origin)
    {
        Uri uri;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out uri)) return false;
        foreach (System.Net.IPEndPoint endPoint in System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            if (endPoint.Port == uri.Port) return true;
        return false;
    }

    // 既に動いていればそのセッションを、止まっていればサーバーを起動して準備完了を待つTaskを返す。
    // サーバー起動（Process.Start）は同期で行うため、repoRootが不正なら呼び出し元へ例外がそのまま届く。
    public static async Task<Task<OnDemandSessionInfo>> BeginSessionAsync(string origin, string repoRoot, int idleTimeoutMs)
    {
        if (IsListening(origin))
        {
            OnDemandSessionInfo running = await FetchSessionAsync(origin, 2000);
            if (running != null) return Task.FromResult(running);
        }
        StartServer(repoRoot, idleTimeoutMs);
        return WaitForSessionAsync(origin, TimeSpan.FromSeconds(20));
    }

    public static void StartServer(string repoRoot, int idleTimeoutMs)
    {
        ProcessStartInfo info = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = "/c npm start",
            WorkingDirectory = repoRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // オンデマンド起動であることをNode側へ伝え、アイドル時に自動終了させる。
        info.EnvironmentVariables["CLIPLINK_IDLE_TIMEOUT_MS"] = idleTimeoutMs.ToString();
        // ショートカットは常駐プログラム側が受け持つ。Node常駐版(旧方式)のRegisterHotKeyと競合しないよう必ず無効化する。
        info.EnvironmentVariables["CLIPLINK_HOTKEY"] = "off";
        Process server = Process.Start(info);
        server.OutputDataReceived += (s, e) => { };
        server.ErrorDataReceived += (s, e) => { };
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
    }

    private static bool IsKeyDown(int vKey)
    {
        return (GetAsyncKeyState(vKey) & 0x8000) != 0;
    }

    // vKeysのいずれかが押下中の間ポーリングし、全て解放されたらtrue、timeoutに達したらfalseを返す。
    // GetAsyncKeyStateはkeybd_eventによる合成押下にも反応するため、テストは実キーボードを使わず
    // 無害な仮想キー(未使用のファンクションキー等)への合成押下/解放で待機ロジックだけを検証できる。
    // publicなのはこの理由でテストから直接呼び出すため。
    public static async Task<bool> WaitForKeysReleasedAsync(int[] vKeys, TimeSpan timeout, TimeSpan pollInterval)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        while (Array.Exists(vKeys, IsKeyDown))
        {
            if (DateTime.UtcNow >= deadline) return false;
            await Task.Delay(pollInterval);
        }
        return true;
    }

    // heldKeysは呼び出し元のショートカットで押されているキー（修飾キーを含む）。nullなら初期値のCtrl+Alt+{S,R}とみなす。
    private static async Task LaunchSnippingToolAsync(byte key, int[] heldKeys)
    {
        // 呼び出し元はショートカットのWM_HOTKEY直後に起動される。そのキーがまだ押しっぱなしの間に
        // 合成Win+Shift+{key}を送ると、OSに渡る同時押下状態が例えばCtrl+Alt+Win+Shift+{key}になり
        // Snipping Toolの範囲選択/録画ショートカット(Win+Shift+単体)と一致せず、UIが開かないまま
        // (新規ファイルも作られないまま)静かに失敗する。物理キーが上がるまで待ってから送信する。
        // ショートカットは利用者が変えられるため、待つキーは実際の組み合わせから受け取る。
        // timeoutに達しても送信自体は行う(待機導入前の挙動を下回らないためのフェイルセーフ)。
        await WaitForKeysReleasedAsync(heldKeys ?? new[] { (int)VkControl, VkMenu, key }, TimeSpan.FromSeconds(2), TimeSpan.FromMilliseconds(20));

        keybd_event(VkLWin, 0, 0, UIntPtr.Zero);
        keybd_event(VkShift, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 2, UIntPtr.Zero);
        keybd_event(VkShift, 0, 2, UIntPtr.Zero);
        keybd_event(VkLWin, 0, 2, UIntPtr.Zero);
    }

    private static int CompleteUpload(CliplinkUploadResult result, string shareBase)
    {
        if (result.StatusCode != 201)
        {
            Report("ERROR import-failed " + result.StatusCode);
            return 6;
        }
        Report("CAPTURED");
        // Clipboard.SetTextはSTA専用のためSTAスレッド上で実行する。
        if (!RunOnSta(() => CliplinkUpload.CopyShareUrlAndOpen(result, shareBase)))
        {
            Report("ERROR share-url-unavailable");
            return 7;
        }
        return 0;
    }

    private static async Task<int> CaptureImageAsync(string origin, Task<OnDemandSessionInfo> sessionTask, int[] heldKeys)
    {
        uint lastSeen = GetClipboardSequenceNumber();
        await LaunchSnippingToolAsync(KeyS, heldKeys);
        DateTime pendingUntil = DateTime.UtcNow.AddSeconds(45);
        while (DateTime.UtcNow < pendingUntil)
        {
            await Task.Delay(250);
            uint current = GetClipboardSequenceNumber();
            if (current == lastSeen) continue;
            lastSeen = current;
            try
            {
                // Clipboard.ContainsImage/GetImageはSTA専用。awaitの継続はThreadPoolへ戻り得るためSTAスレッド上で実行する。
                byte[] png = RunOnSta(() =>
                {
                    if (!Clipboard.ContainsImage()) return null;
                    using (Image image = Clipboard.GetImage())
                    using (MemoryStream stream = new MemoryStream())
                    {
                        image.Save(stream, ImageFormat.Png);
                        return stream.ToArray();
                    }
                });
                if (png == null) continue;
                OnDemandSessionInfo session = await sessionTask;
                if (session == null) { Report("ERROR server-start-failed"); return 8; }
                CliplinkUploadResult result = await CliplinkUpload.SendForShareAsync(origin, session.Token, png);
                return CompleteUpload(result, session.ShareBase);
            }
            catch (ExternalException) { /* clipboard is temporarily held by another app; keep polling */ }
        }
        Report("CANCELLED");
        return 3;
    }

    public static string[] GetVideoFolders()
    {
        string videosFolder = Environment.GetFolderPath(Environment.SpecialFolder.MyVideos);
        string localAppDataFolder = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return new[]
        {
            Path.Combine(videosFolder, "Screen Recordings"),
            Path.Combine(localAppDataFolder, "Packages", "Microsoft.ScreenSketch_8wekyb3d8bbwe", "TempState", "Recordings"),
        };
    }

    // 複数の保存先を横断し、録画開始後に更新されたmp4だけから最新候補を選ぶ。
    // publicなのはWindows側の候補選択を実環境と同じC#コードでテストするため。
    public static FileInfo FindNewestVideoCandidate(string[] folders, DateTime videoStartUtc)
    {
        if (folders == null) return null;
        FileInfo newest = null;
        foreach (string folder in folders)
        {
            if (String.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder)) continue;
            string[] paths;
            try { paths = Directory.GetFiles(folder, "*.mp4"); }
            catch (IOException) { continue; }
            catch (UnauthorizedAccessException) { continue; }
            foreach (string path in paths)
            {
                FileInfo current;
                try
                {
                    current = new FileInfo(path);
                    if (current.Length == 0 || current.LastWriteTimeUtc <= videoStartUtc) continue;
                }
                catch (IOException) { continue; }
                catch (UnauthorizedAccessException) { continue; }

                if (newest == null ||
                    current.LastWriteTimeUtc > newest.LastWriteTimeUtc ||
                    (current.LastWriteTimeUtc == newest.LastWriteTimeUtc && current.CreationTimeUtc > newest.CreationTimeUtc) ||
                    (current.LastWriteTimeUtc == newest.LastWriteTimeUtc && current.CreationTimeUtc == newest.CreationTimeUtc &&
                     StringComparer.OrdinalIgnoreCase.Compare(current.FullName, newest.FullName) > 0))
                    newest = current;
            }
        }
        return newest;
    }

    private static byte[] TryReadStableVideo(FileInfo candidate, long expectedSize, DateTime expectedModified)
    {
        try
        {
            // FileShare.Read lets a completed file be read while preventing a concurrent writer
            // that did not allow a shared read handle from being accepted as upload-ready.
            using (FileStream stream = new FileStream(candidate.FullName, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.SequentialScan))
            {
                if (stream.Length != expectedSize) return null;
                byte[] bytes = new byte[checked((int)expectedSize)];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int read = stream.Read(bytes, offset, bytes.Length - offset);
                    if (read <= 0) return null;
                    offset += read;
                }
                FileInfo afterRead = new FileInfo(candidate.FullName);
                if (afterRead.Length != expectedSize || afterRead.LastWriteTimeUtc != expectedModified) return null;
                return bytes;
            }
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    private static async Task<int> CaptureVideoAsync(string origin, Task<OnDemandSessionInfo> sessionTask, int[] heldKeys)
    {
        DateTime videoStartUtc = DateTime.UtcNow;
        DateTime videoExpireUtc = videoStartUtc.AddMinutes(30);
        await LaunchSnippingToolAsync(KeyR, heldKeys);
        string candidate = "";
        long candidateSize = 0;
        DateTime candidateModified = DateTime.MinValue;
        int stableScans = 0;
        DateTime nextHeartbeatUtc = DateTime.UtcNow + VideoHeartbeatInterval;
        while (DateTime.UtcNow < videoExpireUtc)
        {
            await Task.Delay(1000);
            if (DateTime.UtcNow >= nextHeartbeatUtc)
            {
                // 録画待機中はファイル監視のみでNodeへリクエストを送らないため、放置するとidleタイムアウトでサーバーが落ちる。
                nextHeartbeatUtc = DateTime.UtcNow + VideoHeartbeatInterval;
                await SendHeartbeatAsync(origin);
            }
            FileInfo newest = FindNewestVideoCandidate(GetVideoFolders(), videoStartUtc);
            if (newest == null)
            {
                candidate = "";
                candidateSize = 0;
                candidateModified = DateTime.MinValue;
                stableScans = 0;
                continue;
            }
            if (newest.Length > VideoMaxBytes)
            {
                Report("ERROR video-too-large");
                return 4;
            }
            if (newest.FullName != candidate || newest.Length != candidateSize || newest.LastWriteTimeUtc != candidateModified)
            {
                candidate = newest.FullName;
                candidateSize = newest.Length;
                candidateModified = newest.LastWriteTimeUtc;
                stableScans = 0;
                continue;
            }
            if (DateTime.UtcNow - candidateModified < VideoSettleDelay) continue;
            if (++stableScans < VideoStableScansRequired) continue;
            byte[] bytes = TryReadStableVideo(newest, candidateSize, candidateModified);
            if (bytes == null) { stableScans = 0; continue; }
            Report("VIDEO upload " + bytes.Length + " bytes from " + Path.GetFileName(Path.GetDirectoryName(newest.FullName)));
            OnDemandSessionInfo session = await sessionTask;
            if (session == null) { Report("ERROR server-start-failed"); return 8; }
            DateTime uploadStart = DateTime.UtcNow;
            CliplinkUploadResult result = await CliplinkUpload.SendFileForShareAsync(origin, session.Token, bytes, "recording.mp4", "範囲録画");
            Report("VIDEO uploaded status=" + result.StatusCode + " seconds=" + (int)(DateTime.UtcNow - uploadStart).TotalSeconds);
            return CompleteUpload(result, session.ShareBase);
        }
        Report("ERROR video-save-not-found");
        return 5;
    }

    // Image/Videoで別ガードにすると同時押下でサーバーが二重起動し得るため、
    // アプリ全体で1本の排他ガード(ProductionGuard)に直列化する(modeで分けない)。
    public static Task<int> RunAsync(string mode, string repoRoot)
    {
        return RunAsync(mode, repoRoot, null, ProductionGuard);
    }

    // 常駐プログラムから、押されたショートカットのキー一覧を添えて呼ぶ版（通知領域からの操作は空配列）。
    public static Task<int> RunAsync(string mode, string repoRoot, int[] heldKeys)
    {
        return RunAsync(mode, repoRoot, heldKeys, ProductionGuard);
    }

    // guardNameを外から指定できる版。テストが本番と同じGlobal名前空間へ触れずに
    // 二重起動防止ロジックだけを検証できるようにするための分離。
    public static Task<int> RunAsync(string mode, string repoRoot, string guardName)
    {
        return RunAsync(mode, repoRoot, null, guardName);
    }

    private static async Task<int> RunAsync(string mode, string repoRoot, int[] heldKeys, string guardName)
    {
        string origin = Environment.GetEnvironmentVariable("CLIPLINK_ORIGIN");
        if (String.IsNullOrWhiteSpace(origin)) origin = "http://127.0.0.1:4317";
        int idleTimeoutMs = ParseIdleTimeoutMs(Environment.GetEnvironmentVariable("CLIPLINK_IDLE_TIMEOUT_MS"), 5 * 60 * 1000);
        CliplinkLog.Use(repoRoot);
        Report("START " + mode);

        // 管理画面を開くだけのモード。撮影中（排他中）でも開けるよう排他ガードを使わない。
        if (String.Equals(mode, "Open", StringComparison.OrdinalIgnoreCase))
        {
            if (await (await BeginSessionAsync(origin, repoRoot, idleTimeoutMs)) == null)
            {
                Report("ERROR server-start-failed");
                NotifyFailure(8);
                return 8;
            }
            Process.Start(new ProcessStartInfo(origin + "/") { UseShellExecute = true });
            Report("OPENED dashboard");
            return 0;
        }

        // Windows Mutexはスレッド単位の所有権を持つため、await後の継続がThreadPoolスレッドへ移ると
        // (ここでは実際にそうなる)、取得スレッドと異なるスレッドからのReleaseMutex()がApplicationExceptionになる。
        // Semaphore(1,1)はスレッドに紐付かず任意のスレッドからRelease()できるため、二重起動防止の性質は保ったまま
        // await後のfinallyから安全に解放できる。
        bool createdNew;
        Semaphore instanceGuard = new Semaphore(1, 1, guardName, out createdNew);
        if (!createdNew)
        {
            Report("SKIPPED already-running");
            instanceGuard.Close();
            return 2;
        }
        instanceGuard.WaitOne();
        try
        {
            Task<OnDemandSessionInfo> sessionTask = await BeginSessionAsync(origin, repoRoot, idleTimeoutMs);
            int code;
            try
            {
                code = String.Equals(mode, "Video", StringComparison.OrdinalIgnoreCase)
                    ? await CaptureVideoAsync(origin, sessionTask, heldKeys)
                    : await CaptureImageAsync(origin, sessionTask, heldKeys);
            }
            catch (Exception ex)
            {
                // 送信のタイムアウト等。以前は捕まえずに終了し、画面に何も出なかった。
                Report("ERROR exception " + ex.GetType().Name);
                code = 9;
            }
            Report("END " + mode + " code=" + code);
            NotifyFailure(code);
            return code;
        }
        finally
        {
            instanceGuard.Release();
            instanceGuard.Close();
        }
    }
}

public sealed class OnDemandSessionInfo
{
    public string Token { get; private set; }
    public string ShareBase { get; private set; }

    public OnDemandSessionInfo(string token, string shareBase)
    {
        Token = token;
        ShareBase = shareBase;
    }
}
