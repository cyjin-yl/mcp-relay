// Controlled validation application. It is launched only inside the owned child session.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
internal static class RelayWorkspaceFixture {
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x,int y);
 [STAThread] static void Main(string[] args) {
  if(args.Length!=2) return;
  Guid nonce;if(!Guid.TryParse(args[1],out nonce)) return;
  SetProcessDPIAware();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  var output=Path.GetFullPath(args[0]);var serializer=new JavaScriptSerializer();
  var form=new Form {Text="mcp-relay isolated desktop validation",StartPosition=FormStartPosition.Manual,
    Location=new Point(64,64),ClientSize=new Size(640,340),FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false};
  var label=new Label {Text="Owned test window. No existing documents are opened or changed.",Location=new Point(20,20),AutoSize=true};
  var text=new TextBox {Location=new Point(20,55),Size=new Size(580,90),Multiline=true,AcceptsReturn=true,Font=new Font("Segoe UI",14)};
  var click=new Button {Text="Count a test click",Location=new Point(20,170),Size=new Size(240,48)};
  var warp=new Button {Text="Test child pointer isolation",Location=new Point(280,170),Size=new Size(320,48)};
  var note=new Label {Text="The guardian will return this window in a viewer. It is safe to close it afterward.",
    Location=new Point(20,245),Size=new Size(600,70)};
  form.Controls.AddRange(new Control[]{label,text,click,warp,note});
  int clicks=0,warps=0;bool shown=false,closed=false;var self=Process.GetCurrentProcess();
  Func<Control,object> rectangle=control=>{var p=control.PointToScreen(Point.Empty);return new{x=p.X,y=p.Y,width=control.Width,height=control.Height};};
  Action save=()=>{
   if(!shown)return;
   var value=new {schema=1,nonce=nonce.ToString(),pid=self.Id,session=self.SessionId,
    started=self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(),closed,text=text.Text,clicks,warps,
    textBox=rectangle(text),clickButton=rectangle(click),pointerButton=rectangle(warp),
    updatedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};
   var temp=output+"."+Guid.NewGuid().ToString("N")+".tmp";
   File.WriteAllText(temp,serializer.Serialize(value),new UTF8Encoding(false));
   if(File.Exists(output))File.Replace(temp,output,null);else File.Move(temp,output);
  };
  form.Shown+=(s,e)=>{shown=true;text.Focus();save();};
  text.TextChanged+=(s,e)=>save();
  click.Click+=(s,e)=>{clicks++;save();};
  warp.Click+=(s,e)=>{warps++;SetCursorPos(100+(warps%2)*350,100+(warps%2)*140);save();};
  form.FormClosing+=(s,e)=>{closed=true;save();};
  Application.Run(form);
 }
}
