using System;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
class NativeProof {
  static int Main(string[] args) {
    if (args.Length >= 1 && args[0] == "id") {
      var p = Process.GetProcessById(int.Parse(args[1]));
      Console.Write(p.StartTime.ToUniversalTime().ToString("o"));
      return 0;
    }
    var id = WindowsIdentity.GetCurrent();
    var me = id.User.Value;
    var tokenOwner = id.Owner.Value;
    var sb = new StringBuilder("[");
    for (int i = 0; i < args.Length; i++) {
      var p = args[i];
      var di = new DirectoryInfo(p);
      FileSystemSecurity a = di.Exists ? (FileSystemSecurity)di.GetAccessControl() : new FileInfo(p).GetAccessControl();
      var ownerSid = ((SecurityIdentifier)a.GetOwner(typeof(SecurityIdentifier))).Value;
      var rules = a.GetAccessRules(true, true, typeof(SecurityIdentifier));
      if (i > 0) sb.Append(',');
      var reparse = (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0 ? "true" : "false";
      sb.Append("{\"user\":\"" + me + "\",\"tokenOwner\":\"" + tokenOwner + "\",\"owner\":\"" + ownerSid + "\",\"reparse\":" + reparse + ",\"rules\":[");
      int n = 0;
      foreach (FileSystemAccessRule r in rules) {
        if (n++ > 0) sb.Append(',');
        sb.Append("{\"sid\":\"" + r.IdentityReference.Value + "\",\"type\":\"" + r.AccessControlType + "\",\"rights\":" + (long)r.FileSystemRights + "}");
      }
      sb.Append("]}");
    }
    sb.Append("]");
    Console.Write(sb.ToString());
    return 0;
  }
}
