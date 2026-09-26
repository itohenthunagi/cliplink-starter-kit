using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows.Forms;

public sealed class CliplinkUploadResult
{
    public int StatusCode { get; private set; }
    public string ShareUrl { get; private set; }

    public CliplinkUploadResult(int statusCode, string shareUrl)
    {
        StatusCode = statusCode;
        ShareUrl = shareUrl ?? "";
    }
}

public static class CliplinkUpload
{
    public static bool IsValidShareUrl(string shareUrl, string expectedShareBase)
    {
        Uri uri;
        Uri expectedBase;
        if (String.IsNullOrWhiteSpace(shareUrl) || shareUrl != shareUrl.Trim() ||
            !Uri.TryCreate(shareUrl, UriKind.Absolute, out uri) ||
            !Uri.TryCreate(expectedShareBase, UriKind.Absolute, out expectedBase) ||
            (expectedBase.Scheme != Uri.UriSchemeHttp && expectedBase.Scheme != Uri.UriSchemeHttps) ||
            !String.Equals(uri.GetLeftPart(UriPartial.Authority), expectedBase.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase) ||
            uri.Scheme != expectedBase.Scheme ||
            !String.IsNullOrEmpty(uri.UserInfo) || !String.IsNullOrEmpty(uri.Query) || !String.IsNullOrEmpty(uri.Fragment) ||
            !String.IsNullOrEmpty(expectedBase.UserInfo) || !String.IsNullOrEmpty(expectedBase.Query) || !String.IsNullOrEmpty(expectedBase.Fragment))
            return false;

        string expectedPathPrefix = expectedBase.AbsolutePath.TrimEnd('/') + "/s/";
        if (!uri.AbsolutePath.StartsWith(expectedPathPrefix, StringComparison.Ordinal)) return false;
        string slug = uri.AbsolutePath.Substring(expectedPathPrefix.Length);
        if (slug.Length != 32) return false;
        foreach (char character in slug)
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                return false;
        return true;
    }

    public static bool CopyShareUrlAndOpen(CliplinkUploadResult result, string expectedShareBase)
    {
        if (result == null || result.StatusCode != 201 || !IsValidShareUrl(result.ShareUrl, expectedShareBase))
            return false;
        try
        {
            Clipboard.SetText(result.ShareUrl);
            Process.Start(new ProcessStartInfo(result.ShareUrl) { UseShellExecute = true });
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    public static async Task<int> SendAsync(string origin, string token, byte[] png)
    {
        return (await SendForShareAsync(origin, token, png)).StatusCode;
    }

    public static async Task<int> SendFileAsync(string origin, string token, byte[] bytes, string fileName, string titlePrefix)
    {
        return (await SendFileForShareAsync(origin, token, bytes, fileName, titlePrefix)).StatusCode;
    }

    public static async Task<CliplinkUploadResult> SendForShareAsync(string origin, string token, byte[] png)
    {
        return await SendFileForShareAsync(origin, token, png, "screenshot.png", "範囲キャプチャ");
    }

    public static async Task<CliplinkUploadResult> SendFileForShareAsync(string origin, string token, byte[] bytes, string fileName, string titlePrefix)
    {
        // 既定の100秒では、cloudモードで大きな動画を原本・公開版の2回Dropboxへ送る間に打ち切られ得る。
        using (HttpClient client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) })
        using (MultipartFormDataContent form = new MultipartFormDataContent())
        {
            // .NET Framework leaves disposition names unquoted; Node's FormData parser rejects them.
            foreach (var parameter in form.Headers.ContentType.Parameters)
                if (parameter.Name == "boundary") parameter.Value = parameter.Value.Trim('"');
            ByteArrayContent file = new ByteArrayContent(bytes);
            form.Add(file, "file", fileName);
            file.Headers.ContentDisposition.Name = "\"file\"";
            file.Headers.ContentDisposition.FileName = "\"" + fileName + "\"";
            file.Headers.ContentDisposition.FileNameStar = null;
            StringContent title = new StringContent(titlePrefix + " " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            form.Add(title, "title");
            title.Headers.ContentDisposition.Name = "\"title\"";
            StringContent capturedAt = new StringContent(DateTime.UtcNow.ToString("o"));
            form.Add(capturedAt, "captureAt");
            capturedAt.Headers.ContentDisposition.Name = "\"captureAt\"";
            StringContent publishNow = new StringContent("true");
            form.Add(publishNow, "publishNow");
            publishNow.Headers.ContentDisposition.Name = "\"publishNow\"";
            using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, origin + "/api/assets"))
            {
                request.Headers.Add("x-cliplink-token", token);
                request.Content = form;
                using (HttpResponseMessage response = await client.SendAsync(request))
                {
                    string shareUrl = "";
                    IEnumerable<string> shareUrlValues;
                    if ((int)response.StatusCode == 201 && response.Headers.TryGetValues("X-Cliplink-Share-Url", out shareUrlValues))
                    {
                        foreach (string value in shareUrlValues)
                        {
                            shareUrl = value;
                            break;
                        }
                    }
                    return new CliplinkUploadResult((int)response.StatusCode, shareUrl);
                }
            }
        }
    }
}

public sealed class CliplinkHotkey : Form
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr handle, int id, uint modifiers, uint key);
    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr handle, int id);
    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    private const int HotkeyMessage = 0x0312;
    private readonly Timer timer = new Timer();
    private readonly string origin = Environment.GetEnvironmentVariable("CLIPLINK_ORIGIN");
    private readonly string configuredShareBase = Environment.GetEnvironmentVariable("CLIPLINK_SHARE_BASE");
    private readonly string token = Environment.GetEnvironmentVariable("CLIPLINK_LOCAL_TOKEN");
    private readonly int parentPid = int.Parse(Environment.GetEnvironmentVariable("CLIPLINK_PARENT_PID"));
    private bool registered;
    private bool registeredVideo;
    private bool pending;
    private bool uploading;
    private uint clipboardSequence;
    private DateTime pendingUntil;
    private DateTime launchAt;
    private bool pendingVideo;
    private bool uploadingVideo;
    private DateTime videoStartUtc;
    private DateTime videoExpireUtc;
    private DateTime videoLaunchAt;
    private DateTime lastVideoScan;
    private string videoCandidate = "";
    private long videoCandidateSize;
    private DateTime videoCandidateModified;
    private int videoStableScans;

    private string ExpectedShareBase
    {
        get { return String.IsNullOrWhiteSpace(configuredShareBase) ? origin : configuredShareBase; }
    }

    public CliplinkHotkey()
    {
        ShowInTaskbar = false;
        WindowState = FormWindowState.Minimized;
        timer.Interval = 250;
        timer.Tick += Tick;
        timer.Start();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Ctrl+Alt+S. MOD_NOREPEAT prevents repeated captures while held.
        registered = RegisterHotKey(Handle, 1, 0x0002 | 0x0001 | 0x4000, 0x53);
        registeredVideo = RegisterHotKey(Handle, 2, 0x0002 | 0x0001 | 0x4000, 0x52);
        Console.WriteLine(!registered ? "ERROR hotkey-unavailable" : registeredVideo ? "READY" : "READY_IMAGE_ONLY");
        if (!registered) BeginInvoke(new Action(Close));
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Hide();
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == HotkeyMessage && message.WParam.ToInt32() == 1)
        {
            clipboardSequence = GetClipboardSequenceNumber();
            pending = true;
            pendingUntil = DateTime.UtcNow.AddSeconds(45);
            launchAt = DateTime.UtcNow.AddMilliseconds(400);
        }
        if (message.Msg == HotkeyMessage && message.WParam.ToInt32() == 2)
        {
            pendingVideo = true;
            videoStartUtc = DateTime.UtcNow;
            videoExpireUtc = videoStartUtc.AddMinutes(30);
            videoLaunchAt = videoStartUtc.AddMilliseconds(400);
            lastVideoScan = DateTime.MinValue;
            videoCandidate = "";
            videoStableScans = 0;
        }
        base.WndProc(ref message);
    }

    private async void Tick(object sender, EventArgs e)
    {
        try
        {
            if (Process.GetProcessById(parentPid).HasExited) { Close(); return; }
        }
        catch (ArgumentException) { Close(); return; }

        if (pendingVideo && !uploadingVideo) await PollVideo();
        if (!pending || uploading) return;
        if (DateTime.UtcNow > pendingUntil) { pending = false; return; }
        if (launchAt != DateTime.MinValue && DateTime.UtcNow >= launchAt)
        {
            launchAt = DateTime.MinValue;
            // Invoke the documented Windows region snip shortcut from the registered hotkey.
            LaunchSnippingTool(0x53);
            return;
        }
        if (launchAt != DateTime.MinValue) return;
        uint current = GetClipboardSequenceNumber();
        if (current == clipboardSequence) return;
        try
        {
            if (!Clipboard.ContainsImage()) { clipboardSequence = current; return; }
            using (Image image = Clipboard.GetImage())
            using (MemoryStream stream = new MemoryStream())
            {
                image.Save(stream, ImageFormat.Png);
                clipboardSequence = current;
                pending = false;
                uploading = true;
                CliplinkUploadResult result = await CliplinkUpload.SendForShareAsync(origin, token, stream.ToArray());
                CompleteUpload(result);
                uploading = false;
            }
        }
        catch (ExternalException) { /* clipboard is temporarily held by another app */ }
        catch (Exception) { pending = false; uploading = false; Console.WriteLine("ERROR capture-failed"); }
    }

    private static void LaunchSnippingTool(byte key)
    {
        keybd_event(0x5B, 0, 0, UIntPtr.Zero); // Windows
        keybd_event(0x10, 0, 0, UIntPtr.Zero); // Shift
        keybd_event(key, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 2, UIntPtr.Zero);
        keybd_event(0x10, 0, 2, UIntPtr.Zero);
        keybd_event(0x5B, 0, 2, UIntPtr.Zero);
    }

    private async Task PollVideo()
    {
        if (DateTime.UtcNow > videoExpireUtc)
        {
            pendingVideo = false;
            Console.WriteLine("ERROR video-save-not-found");
            return;
        }
        if (videoLaunchAt != DateTime.MinValue)
        {
            if (DateTime.UtcNow >= videoLaunchAt)
            {
                videoLaunchAt = DateTime.MinValue;
                LaunchSnippingTool(0x52); // Win+Shift+R opens region recording.
            }
            return;
        }
        if ((DateTime.UtcNow - lastVideoScan).TotalSeconds < 1) return;
        lastVideoScan = DateTime.UtcNow;
        string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "Screen Recordings");
        if (!Directory.Exists(folder)) return;
        FileInfo newest = null;
        foreach (string path in Directory.GetFiles(folder, "*.mp4"))
        {
            FileInfo info = new FileInfo(path);
            if (info.LastWriteTimeUtc < videoStartUtc || (newest != null && info.LastWriteTimeUtc <= newest.LastWriteTimeUtc)) continue;
            newest = info;
        }
        if (newest == null || newest.Length == 0) return;
        if (newest.Length > 100 * 1024 * 1024)
        {
            pendingVideo = false;
            Console.WriteLine("ERROR video-too-large");
            return;
        }
        if (newest.FullName != videoCandidate || newest.Length != videoCandidateSize || newest.LastWriteTimeUtc != videoCandidateModified)
        {
            videoCandidate = newest.FullName;
            videoCandidateSize = newest.Length;
            videoCandidateModified = newest.LastWriteTimeUtc;
            videoStableScans = 0;
            return;
        }
        if (++videoStableScans < 2) return;
        try
        {
            byte[] bytes = File.ReadAllBytes(newest.FullName);
            if (bytes.Length != videoCandidateSize) { videoStableScans = 0; return; }
            pendingVideo = false;
            uploadingVideo = true;
            CliplinkUploadResult result = await CliplinkUpload.SendFileForShareAsync(origin, token, bytes, "recording.mp4", "範囲録画");
            CompleteUpload(result);
            uploadingVideo = false;
        }
        catch (IOException) { videoStableScans = 0; }
        catch (Exception) { pendingVideo = false; uploadingVideo = false; Console.WriteLine("ERROR capture-failed"); }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        timer.Stop();
        if (registered) UnregisterHotKey(Handle, 1);
        if (registeredVideo) UnregisterHotKey(Handle, 2);
        base.OnFormClosed(e);
    }

    private void CompleteUpload(CliplinkUploadResult result)
    {
        if (result.StatusCode != 201)
        {
            Console.WriteLine("ERROR import-failed " + result.StatusCode);
            return;
        }
        Console.WriteLine("CAPTURED");
        if (!CliplinkUpload.CopyShareUrlAndOpen(result, ExpectedShareBase))
            Console.WriteLine("ERROR share-url-unavailable");
    }
}
