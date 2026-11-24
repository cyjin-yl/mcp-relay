import json, os, pathlib, subprocess, sys, time
OUT=pathlib.Path(os.environ["RELAY_MAP_PROBE_DIR"])
OUT.mkdir(parents=True,exist_ok=True)
if len(sys.argv)>1:
    import gi
    gi.require_version("Gtk","3.0")
    from gi.repository import Gtk,Gdk,GLib
    mode=sys.argv[1]
    w=Gtk.Window(title="Relay foreground fixture" if mode=="foreground" else "Relay recovery viewer probe")
    w.set_default_size(500,300)
    if mode!="foreground":
        w.set_focus_on_map(False)
        if mode=="no-accept": w.set_accept_focus(False)
    label=Gtk.Label(label="Local foreground" if mode=="foreground" else "Recovered workspace")
    w.add(label)
    result={"mode":mode,"pid":os.getpid(),"backend":Gdk.Display.get_default().__gtype__.name,"events":[],"frames":[]}
    def save():
        p=OUT/(mode+".json")
        t=OUT/(mode+".tmp")
        t.write_text(json.dumps(result))
        t.replace(p)
    def state(*_):
        result["events"].append({"at":time.monotonic(),"mapped":w.get_mapped(),"visible":w.get_visible(),"focused":w.is_active()})
        save()
    w.connect("notify::is-active",state)
    w.connect("map-event",state)
    w.connect("unmap-event",state)
    w.connect("draw",lambda *_: state())
    def frames():
        clock=w.get_frame_clock()
        if clock:
            counter=clock.get_frame_counter()
            for c in range(max(clock.get_history_start(),counter-3),counter+1):
                t=clock.get_timings(c)
                if t and t.get_complete():
                    d={"counter":c,"complete":t.get_complete(),"presentation":t.get_presentation_time(),"frame":t.get_frame_time()}
                    if d not in result["frames"]: result["frames"].append(d)
            result["frames"]=result["frames"][-16:]
        state()
        return True
    w.connect("destroy",Gtk.main_quit)
    w.show_all()
    GLib.timeout_add(200,frames)
    GLib.timeout_add(12000,lambda: (Gtk.main_quit(),False)[1])
    Gtk.main()
else:
    procs=[]
    try:
        env=dict(os.environ,WAYLAND_DEBUG="1")
        def start(mode):
            log=(OUT/(mode+".log")).open("w")
            p=subprocess.Popen([sys.executable,__file__,mode],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            procs.append((p,log))
            return p
        def read(mode):
            try:return json.loads((OUT/(mode+".json")).read_text())
            except (OSError,ValueError):return None
        start("foreground")
        deadline=time.monotonic()+7
        while time.monotonic()<deadline:
            first=read("foreground")
            if first and first["events"][-1]["focused"]:break
            time.sleep(.1)
        else:raise RuntimeError("foreground_never_focused")
        start_time=time.monotonic()
        mode=os.environ.get("RELAY_MAP_PROBE_MODE","viewer")
        start(mode)
        time.sleep(3)
        first,second=read("foreground"),read(mode)
        before=first["events"]
        lost=any(x["at"]>=start_time and not x["focused"] for x in before)
        took=any(x["focused"] for x in second["events"]) if second else None
        result={"foreground":first,"viewer":second,"foregroundLostFocus":lost,"viewerTookFocus":took,"startedViewer":start_time}
        (OUT/"result.json").write_text(json.dumps(result,indent=2))
        print(json.dumps({"foregroundLostFocus":lost,"viewerTookFocus":took,"viewerBackend":second and second["backend"],"viewerFrames":second and second["frames"]},indent=2))
    finally:
        for p,log in procs:
            p.terminate()
        for p,log in procs:
            try:p.wait(timeout=3)
            except subprocess.TimeoutExpired:p.kill();p.wait()
            log.close()
