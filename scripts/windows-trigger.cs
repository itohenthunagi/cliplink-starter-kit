using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

// Windowsの「スタートアップ アプリ」やタスクマネージャーに、ファイル名ではなく「Cliplink」と表示させる。
[assembly: AssemblyTitle("Cliplink")]
[assembly: AssemblyProduct("Cliplink")]

// Cliplinkの常駐プログラム。ショートカットキーの待受と、通知領域のアイコン（管理画面・撮影・設定）を持つ。
// ログイン時にスタートアップのショートカット（windows-install-trigger.ps1が作成）から自動で起動する。
// 撮影・アップロード・共有URL処理は windows-ondemand-capture.cs を同じEXEへ組み込んで呼ぶ。
// 以前は押下のたびにPowerShellを起動してC#をコンパイルしており、撮影画面が出るまで3〜4秒かかっていた。

public static class CliplinkTriggerConfig
{
    public static string ReadRepoRoot(string configPath)
    {
        return ReadString(configPath, "repoRoot");
    }

    public static string ReadString(string path, string name)
    {
        if (!File.Exists(path)) return null;
        string json = File.ReadAllText(path, Encoding.UTF8);
        Match match = Regex.Match(json, "\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        if (!match.Success) return null;
        return match.Groups[1].Value.Replace("\\\\", "\\").Replace("\\\"", "\"");
    }

    public static string JsonString(string value)
    {
        if (value == null) return "null";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}

// "Ctrl+Alt+S" 形式のショートカット指定。修飾キー（Ctrl・Alt・Winのどれか）必須、キーは英数字かF1〜F24。
public static class CliplinkHotkeySpec
{
    public const uint ModAlt = 0x0001;
    public const uint ModControl = 0x0002;
    public const uint ModShift = 0x0004;
    public const uint ModWin = 0x0008;
    // 未設定の表示。設定画面の欄でもこの文字で「なし」を表す。
    public const string None = "なし";

    public static bool TryParse(string text, out uint modifiers, out uint key)
    {
        modifiers = 0;
        key = 0;
        if (String.IsNullOrWhiteSpace(text)) return false;
        foreach (string raw in text.Split('+'))
        {
            string part = raw.Trim().ToUpperInvariant();
            if (part.Length == 0) return false;
            if (part == "CTRL" || part == "CONTROL") { modifiers |= ModControl; continue; }
            if (part == "ALT") { modifiers |= ModAlt; continue; }
            if (part == "SHIFT") { modifiers |= ModShift; continue; }
            if (part == "WIN") { modifiers |= ModWin; continue; }
            if (key != 0) return false;
            if (part.Length == 1 && ((part[0] >= 'A' && part[0] <= 'Z') || (part[0] >= '0' && part[0] <= '9')))
            {
                key = part[0];
                continue;
            }
            int number;
            if (part.StartsWith("F") && int.TryParse(part.Substring(1), out number) && number >= 1 && number <= 24)
            {
                key = (uint)(0x70 + number - 1);
                continue;
            }
            return false;
        }
        // 修飾キーなし（Shiftだけも含む）は普段の文字入力とぶつかるため認めない。
        return key != 0 && (modifiers & (ModControl | ModAlt | ModWin)) != 0;
    }

    public static string Format(uint modifiers, uint key)
    {
        StringBuilder sb = new StringBuilder();
        if ((modifiers & ModControl) != 0) sb.Append("Ctrl+");
        if ((modifiers & ModAlt) != 0) sb.Append("Alt+");
        if ((modifiers & ModShift) != 0) sb.Append("Shift+");
        if ((modifiers & ModWin) != 0) sb.Append("Win+");
        if (key >= 0x70 && key <= 0x87) sb.Append("F").Append(key - 0x70 + 1);
        else sb.Append((char)key);
        return sb.ToString();
    }

    // 画面表示用（"Ctrl + Alt + S"）。未設定は「なし」。
    public static string Display(string spec)
    {
        uint modifiers, key;
        return TryParse(spec, out modifiers, out key) ? Format(modifiers, key).Replace("+", " + ") : None;
    }

    // このショートカットを押した瞬間に押されている仮想キー（本体キーと修飾キー）。
    // 撮影の合成入力(Win+Shift+S/R)は、これらが離されてから送る必要がある。
    public static int[] HeldKeys(string spec)
    {
        uint modifiers, key;
        if (!TryParse(spec, out modifiers, out key)) return new int[0];
        List<int> keys = new List<int> { (int)key };
        if ((modifiers & ModControl) != 0) keys.Add(0x11);
        if ((modifiers & ModAlt) != 0) keys.Add(0x12);
        if ((modifiers & ModShift) != 0) keys.Add(0x10);
        if ((modifiers & ModWin) != 0) { keys.Add(0x5B); keys.Add(0x5C); }
        return keys.ToArray();
    }
}

// 利用者が変えたショートカットの保存先（インストール先の hotkeys.json）。インストーラーの再実行でも消えない。
public sealed class CliplinkHotkeySettings
{
    public const string DefaultImage = "Ctrl+Alt+S";
    public const string DefaultVideo = "Ctrl+Alt+R";
    public string Image = DefaultImage;
    public string Video = DefaultVideo;
    public string Open = "";

    public static CliplinkHotkeySettings Load(string path)
    {
        CliplinkHotkeySettings settings = new CliplinkHotkeySettings();
        if (!File.Exists(path)) return settings;
        string image = CliplinkTriggerConfig.ReadString(path, "image");
        string video = CliplinkTriggerConfig.ReadString(path, "video");
        string open = CliplinkTriggerConfig.ReadString(path, "open");
        if (image != null) settings.Image = image;
        if (video != null) settings.Video = video;
        if (open != null) settings.Open = open;
        return settings;
    }

    public string ToJson()
    {
        return "{\"image\":" + CliplinkTriggerConfig.JsonString(Image) +
            ",\"video\":" + CliplinkTriggerConfig.JsonString(Video) +
            ",\"open\":" + CliplinkTriggerConfig.JsonString(Open) + "}";
    }

    public void Save(string path)
    {
        CliplinkTriggerStatus.WriteAtomic(path, ToJson());
    }
}

public static class CliplinkTriggerGuard
{
    // 名前付きSemaphoreの生成主(createdNew)であり続ける限り、自分が唯一の常駐インスタンスであることの証になる。
    // 常駐アプリなのでWaitOne/Releaseは不要で、プロセス生存中ハンドルを閉じずに持ち続けるだけでよい。
    public static bool IsPrimaryInstance(string guardName, out Semaphore guard)
    {
        bool createdNew;
        guard = new Semaphore(1, 1, guardName, out createdNew);
        if (!createdNew)
        {
            guard.Close();
            guard = null;
        }
        return createdNew;
    }
}

public static class CliplinkTriggerStatus
{
    public static string BuildJson(
        int pid,
        string exePath,
        string startedAtUtc,
        bool hotkeyS,
        bool hotkeyR,
        string lastTriggeredAtUtc,
        string lastTriggeredKey,
        string lastError)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{");
        sb.Append("\"schemaVersion\":1,");
        sb.Append("\"pid\":").Append(pid).Append(",");
        sb.Append("\"exePath\":").Append(CliplinkTriggerConfig.JsonString(exePath)).Append(",");
        sb.Append("\"startedAtUtc\":").Append(CliplinkTriggerConfig.JsonString(startedAtUtc)).Append(",");
        sb.Append("\"hotkeyS\":").Append(CliplinkTriggerConfig.JsonString(hotkeyS ? "registered" : "unavailable")).Append(",");
        sb.Append("\"hotkeyR\":").Append(CliplinkTriggerConfig.JsonString(hotkeyR ? "registered" : "unavailable")).Append(",");
        sb.Append("\"lastTriggeredAtUtc\":").Append(CliplinkTriggerConfig.JsonString(lastTriggeredAtUtc)).Append(",");
        sb.Append("\"lastTriggeredKey\":").Append(CliplinkTriggerConfig.JsonString(lastTriggeredKey)).Append(",");
        sb.Append("\"lastError\":").Append(CliplinkTriggerConfig.JsonString(lastError));
        sb.Append("}");
        return sb.ToString();
    }

    // 読取側(検証用スクリプトや人)が書込み途中の状態を絶対に見ないよう、一時ファイルへ書いてから置き換える。
    public static void WriteAtomic(string path, string json)
    {
        string tempPath = path + ".tmp";
        File.WriteAllText(tempPath, json, Encoding.UTF8);
        if (File.Exists(path)) File.Delete(path);
        File.Move(tempPath, path);
    }
}

// ショートカットキーの設定画面。各欄で新しい組み合わせをそのまま押すと入力される。
public sealed class CliplinkHotkeyDialog : Form
{
    private readonly TextBox image = new TextBox();
    private readonly TextBox video = new TextBox();
    private readonly TextBox open = new TextBox();

    public CliplinkHotkeySettings Result { get; private set; }

    public CliplinkHotkeyDialog(CliplinkHotkeySettings current)
    {
        Text = "Cliplink ショートカットキーの設定";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(440, 250);
        Font = new Font("Yu Gothic UI", 10f);
        Label note = new Label
        {
            Text = "欄をクリックして、新しい組み合わせをそのまま押してください。\nCtrl か Alt を含めます。空にするには Backspace。",
            Location = new Point(16, 12),
            Size = new Size(410, 44),
        };
        Controls.Add(note);
        AddRow("撮影", image, current.Image, 64);
        AddRow("録画", video, current.Video, 104);
        AddRow("管理画面を開く", open, current.Open, 144);
        Button reset = new Button { Text = "初期値に戻す", Location = new Point(16, 200), Size = new Size(120, 32) };
        reset.Click += (s, e) =>
        {
            image.Text = CliplinkHotkeySpec.Display(CliplinkHotkeySettings.DefaultImage);
            video.Text = CliplinkHotkeySpec.Display(CliplinkHotkeySettings.DefaultVideo);
            open.Text = CliplinkHotkeySpec.None;
        };
        Button ok = new Button { Text = "保存", Location = new Point(238, 200), Size = new Size(88, 32) };
        ok.Click += (s, e) => Save();
        Button cancel = new Button { Text = "キャンセル", Location = new Point(334, 200), Size = new Size(90, 32), DialogResult = DialogResult.Cancel };
        Controls.Add(reset);
        Controls.Add(ok);
        Controls.Add(cancel);
        AcceptButton = ok;
        CancelButton = cancel;
    }

    private void AddRow(string label, TextBox box, string value, int top)
    {
        Controls.Add(new Label { Text = label, Location = new Point(16, top + 4), Size = new Size(120, 24) });
        box.Location = new Point(140, top);
        box.Size = new Size(284, 28);
        box.ReadOnly = true;
        box.BackColor = Color.White;
        box.Text = CliplinkHotkeySpec.Display(value);
        box.KeyDown += (s, e) =>
        {
            e.SuppressKeyPress = true;
            e.Handled = true;
            if (e.KeyCode == Keys.Back || e.KeyCode == Keys.Delete) { box.Text = CliplinkHotkeySpec.None; return; }
            uint modifiers = 0;
            if (e.Control) modifiers |= CliplinkHotkeySpec.ModControl;
            if (e.Alt) modifiers |= CliplinkHotkeySpec.ModAlt;
            if (e.Shift) modifiers |= CliplinkHotkeySpec.ModShift;
            uint key = (uint)e.KeyCode;
            uint parsedModifiers, parsedKey;
            string spec = CliplinkHotkeySpec.Format(modifiers, key);
            if (CliplinkHotkeySpec.TryParse(spec, out parsedModifiers, out parsedKey)) box.Text = spec.Replace("+", " + ");
        };
        // Alt単体の押下でメニュー操作へ移らないようにする。
        box.PreviewKeyDown += (s, e) => { e.IsInputKey = true; };
        Controls.Add(box);
    }

    private static string ToSpec(TextBox box)
    {
        return box.Text == CliplinkHotkeySpec.None ? "" : box.Text.Replace(" ", "");
    }

    private void Save()
    {
        CliplinkHotkeySettings next = new CliplinkHotkeySettings { Image = ToSpec(image), Video = ToSpec(video), Open = ToSpec(open) };
        string[] specs = { next.Image, next.Video, next.Open };
        for (int i = 0; i < specs.Length; i++)
            for (int j = i + 1; j < specs.Length; j++)
                if (specs[i] != "" && String.Equals(specs[i], specs[j], StringComparison.OrdinalIgnoreCase))
                {
                    MessageBox.Show(this, "同じ組み合わせが2か所に入っています。別の組み合わせにしてください。", "Cliplink");
                    return;
                }
        Result = next;
        DialogResult = DialogResult.OK;
        Close();
    }
}

public sealed class CliplinkTriggerApp : Form
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr handle, int id, uint modifiers, uint key);
    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr handle, int id);

    private const int HotkeyMessage = 0x0312;
    private const uint ModNoRepeat = 0x4000;
    // 通知領域からの操作はマウスなので、撮影前に離されるのを待つキーはない。
    private static readonly int[] NoHeldKeys = new int[0];

    // ショートカット1つ分（登録ID・実行する処理・設定値の取り出し方・登録できたか）。
    private sealed class HotkeyBinding
    {
        public readonly int Id;
        public readonly string Mode;
        public readonly Func<CliplinkHotkeySettings, string> Spec;
        public bool Registered;

        public HotkeyBinding(int id, string mode, Func<CliplinkHotkeySettings, string> spec)
        {
            Id = id;
            Mode = mode;
            Spec = spec;
        }
    }

    private readonly HotkeyBinding image = new HotkeyBinding(1, "Image", s => s.Image);
    private readonly HotkeyBinding video = new HotkeyBinding(2, "Video", s => s.Video);
    private readonly HotkeyBinding open = new HotkeyBinding(3, "Open", s => s.Open);
    private readonly HotkeyBinding[] bindings;

    // 生存中ずっと保持し、二重起動防止の証（名前付きSemaphoreの生成主）であり続ける。
    private readonly Semaphore guard;
    private readonly string repoRoot;
    private readonly string statusPath;
    private readonly string hotkeysPath;
    private readonly string exePath;
    private readonly string startedAtUtc = DateTime.UtcNow.ToString("o");
    private readonly object statusLock = new object();
    private readonly NotifyIcon tray = new NotifyIcon();
    private CliplinkHotkeySettings settings;

    public CliplinkTriggerApp(Semaphore guard, string repoRoot, string statusPath, string hotkeysPath, string exePath)
    {
        this.guard = guard;
        this.repoRoot = repoRoot;
        this.statusPath = statusPath;
        this.hotkeysPath = hotkeysPath;
        this.exePath = exePath;
        bindings = new[] { image, video, open };
        settings = CliplinkHotkeySettings.Load(hotkeysPath);
        ShowInTaskbar = false;
        WindowState = FormWindowState.Minimized;
        Opacity = 0;

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("管理画面を開く", null, (s, e) => Run("Open", "tray", NoHeldKeys));
        menu.Items.Add("範囲を撮影", null, (s, e) => Run("Image", "tray", NoHeldKeys));
        menu.Items.Add("範囲を録画", null, (s, e) => Run("Video", "tray", NoHeldKeys));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("ショートカットキーの設定…", null, (s, e) => ShowSettings());
        menu.Items.Add("Cliplinkを終了", null, (s, e) => Close());
        tray.ContextMenuStrip = menu;
        tray.Icon = CreateIcon();
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Run("Open", "tray", NoHeldKeys); };
        tray.Visible = true;
    }

    // 深緑の四角に黄緑の矢印（管理画面と同じ配色）。外部の画像ファイルに頼らず描く。
    private static Icon CreateIcon()
    {
        using (Bitmap bitmap = new Bitmap(32, 32))
        using (Graphics g = Graphics.FromImage(bitmap))
        using (SolidBrush background = new SolidBrush(Color.FromArgb(37, 79, 60)))
        using (Pen arrow = new Pen(Color.FromArgb(222, 240, 129), 4f))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.FillRectangle(background, 2, 2, 28, 28);
            arrow.StartCap = System.Drawing.Drawing2D.LineCap.Round;
            arrow.EndCap = System.Drawing.Drawing2D.LineCap.Round;
            g.DrawLine(arrow, 9, 23, 23, 9);
            g.DrawLine(arrow, 12, 9, 23, 9);
            g.DrawLine(arrow, 23, 9, 23, 20);
            return Icon.FromHandle(bitmap.GetHicon());
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        string failed = RegisterAll();
        UpdateTooltip();
        WriteStatus(null, null, failed);
        if (failed != null)
            tray.ShowBalloonTip(8000, "Cliplink", failed + " は他のアプリが使用中のため登録できませんでした。アイコンを右クリック →「ショートカットキーの設定」で変更できます。", ToolTipIcon.Warning);
    }

    // 登録できなかった組み合わせを「、」区切りで返す（全部成功ならnull）。
    private string RegisterAll()
    {
        UnregisterAll();
        StringBuilder failed = new StringBuilder();
        foreach (HotkeyBinding binding in bindings)
        {
            string spec = binding.Spec(settings);
            uint modifiers, key;
            // 未設定（空）は登録しないだけで、失敗には数えない。
            if (!CliplinkHotkeySpec.TryParse(spec, out modifiers, out key)) continue;
            binding.Registered = RegisterHotKey(Handle, binding.Id, modifiers | ModNoRepeat, key);
            if (binding.Registered) continue;
            if (failed.Length > 0) failed.Append("、");
            failed.Append(CliplinkHotkeySpec.Display(spec));
        }
        return failed.Length == 0 ? null : failed.ToString();
    }

    private void UnregisterAll()
    {
        foreach (HotkeyBinding binding in bindings)
        {
            if (binding.Registered) UnregisterHotKey(Handle, binding.Id);
            binding.Registered = false;
        }
    }

    private void UpdateTooltip()
    {
        // 通知領域のツールチップは63文字まで。
        string text = "Cliplink  撮影 " + CliplinkHotkeySpec.Display(settings.Image) + " / 録画 " + CliplinkHotkeySpec.Display(settings.Video);
        tray.Text = text.Length > 63 ? text.Substring(0, 63) : text;
    }

    private void ShowSettings()
    {
        using (CliplinkHotkeyDialog dialog = new CliplinkHotkeyDialog(settings))
        {
            if (dialog.ShowDialog() != DialogResult.OK) return;
            CliplinkHotkeySettings previous = settings;
            settings = dialog.Result;
            string failed = RegisterAll();
            if (failed != null)
            {
                MessageBox.Show(failed + " は他のアプリが使用中のため登録できませんでした。元の設定に戻します。", "Cliplink", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                settings = previous;
                RegisterAll();
            }
            else
            {
                try { settings.Save(hotkeysPath); } catch (Exception) { /* 保存失敗でも今回の登録は有効 */ }
            }
            UpdateTooltip();
            WriteStatus(null, null, failed);
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Hide();
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == HotkeyMessage)
        {
            int id = message.WParam.ToInt32();
            foreach (HotkeyBinding binding in bindings)
                if (binding.Id == id && binding.Registered)
                    Run(binding.Mode, binding.Mode.ToLowerInvariant(), CliplinkHotkeySpec.HeldKeys(binding.Spec(settings)));
        }
        base.WndProc(ref message);
    }

    // 撮影処理はこのプロセスの中で走らせる（PowerShell起動・C#コンパイルを毎回しない）。メッセージループは止めない。
    private void Run(string mode, string source, int[] heldKeys)
    {
        WriteStatus(DateTime.UtcNow.ToString("o"), source, null);
        string root = repoRoot;
        Task.Run(async () =>
        {
            try { await CliplinkOnDemandCapture.RunAsync(mode, root, heldKeys); }
            catch (Exception ex) { WriteStatus(DateTime.UtcNow.ToString("o"), source, ex.GetType().Name); }
        });
    }

    private void WriteStatus(string lastTriggeredAtUtc, string lastTriggeredKey, string error)
    {
        try
        {
            string json = CliplinkTriggerStatus.BuildJson(
                Process.GetCurrentProcess().Id, exePath, startedAtUtc, image.Registered, video.Registered,
                lastTriggeredAtUtc, lastTriggeredKey, error);
            lock (statusLock) CliplinkTriggerStatus.WriteAtomic(statusPath, json);
        }
        catch (Exception) { /* 状態ファイルの書込み失敗でリスナー自体は止めない */ }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        UnregisterAll();
        tray.Visible = false;
        tray.Dispose();
        base.OnFormClosed(e);
    }
}

public static class Program
{
    [STAThread]
    public static void Main()
    {
        string exePath = Assembly.GetExecutingAssembly().Location;
        string installDir = Path.GetDirectoryName(exePath);
        string configPath = Path.Combine(installDir, "trigger-config.json");
        string statusPath = Path.Combine(installDir, "trigger-status.json");
        string hotkeysPath = Path.Combine(installDir, "hotkeys.json");
        string repoRoot = CliplinkTriggerConfig.ReadRepoRoot(configPath);
        // 設定不備でホットキーを取ってしまうと無音で無意味な常駐だけが残る。状態ファイルも書かず即終了する。
        if (String.IsNullOrWhiteSpace(repoRoot)) return;

        Semaphore guard;
        if (!CliplinkTriggerGuard.IsPrimaryInstance("Global\\CliplinkTrigger", out guard)) return;

        // 起動と、予期しない例外の理由を後から確かめられるよう、repo の .cliplink/capture.log に残す。
        CliplinkLog.Use(repoRoot);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (s, e) => LogError(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (s, e) => LogError(e.ExceptionObject as Exception);
        CliplinkLog.Write("TRIGGER started pid=" + Process.GetCurrentProcess().Id);
        Application.EnableVisualStyles();
        Application.Run(new CliplinkTriggerApp(guard, repoRoot, statusPath, hotkeysPath, exePath));
    }

    private static void LogError(Exception error)
    {
        if (error != null) CliplinkLog.Write("TRIGGER error " + error.GetType().Name + ": " + error.Message);
    }
}
