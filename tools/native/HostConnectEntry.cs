using System;
using System.IO;
using System.Windows.Forms;

internal static class StartupSettings {
 public const string Kind = "Suite";
 public const string Title = "星语汉化套件";

 public static void StartApp(bool background) {
  // Standalone connection helper does not auto-launch packaged single-plugin apps.
 }

 public static void CreateShortcut(string file, string target, string arguments) {
  Directory.CreateDirectory(Path.GetDirectoryName(file));
  Type t = Type.GetTypeFromProgID("WScript.Shell");
  dynamic shell = Activator.CreateInstance(t);
  dynamic lnk = shell.CreateShortcut(file);
  lnk.TargetPath = target;
  lnk.Arguments = arguments;
  lnk.WorkingDirectory = Path.GetDirectoryName(target);
  lnk.IconLocation = target + ",0";
  lnk.Save();
 }
}

internal static class HostConnectEntry {
 [STAThread]
 public static void Main(string[] args) {
  Application.EnableVisualStyles();
  try {
   if (args.Length > 0 && args[0] == "--self-test") {
    HostConnection.SelfTest();
    return;
   }
   if (args.Length > 0 && (args[0] == "--restore" || args[0] == "--restore-connection")) {
    HostConnection.RestoreWithNotice();
    return;
   }
   HostConnection.Connect();
  } catch (Exception e) {
   MessageBox.Show(e.Message, StartupSettings.Title);
   Environment.ExitCode = 1;
  }
 }
}
