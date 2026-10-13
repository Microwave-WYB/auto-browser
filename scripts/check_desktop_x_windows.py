# Isolated evidence only: inspect X clients without extra product packages.
import ctypes as C
import json
import os
import selectors
import sys
import time

x = C.CDLL("libX11.so.6")
x.XOpenDisplay.argtypes = [C.c_char_p]; x.XOpenDisplay.restype = C.c_void_p
d = x.XOpenDisplay(os.environ.get("DISPLAY", ":99").encode())
if not d: raise RuntimeError("no display")
for name in ["XDefaultRootWindow", "XConnectionNumber", "XPending"]:
    getattr(x, name).argtypes = [C.c_void_p]
x.XDefaultRootWindow.restype = C.c_ulong
x.XInternAtom.argtypes = [C.c_void_p, C.c_char_p, C.c_int]; x.XInternAtom.restype = C.c_ulong
x.XGetWindowProperty.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong, C.c_long, C.c_long, C.c_int, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.c_void_p)]
x.XGetGeometry.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint)]
x.XGetInputFocus.argtypes = [C.c_void_p, C.POINTER(C.c_ulong), C.POINTER(C.c_int)]
x.XSelectInput.argtypes = [C.c_void_p, C.c_ulong, C.c_long]
x.XNextEvent.argtypes = [C.c_void_p, C.c_void_p]
x.XFlush.argtypes = [C.c_void_p]
x.XFree.argtypes = [C.c_void_p]
root = x.XDefaultRootWindow(d)
def prop(w, name):
    actual, fmt, n, left, data = C.c_ulong(), C.c_int(), C.c_ulong(), C.c_ulong(), C.c_void_p()
    x.XGetWindowProperty(d, w, x.XInternAtom(d, name.encode(), 0), 0, 1024, 0, 0, C.byref(actual), C.byref(fmt), C.byref(n), C.byref(left), C.byref(data))
    out = list(C.cast(data, C.POINTER(C.c_ulong))[:n.value]) if fmt.value == 32 else C.string_at(data, n.value).decode(errors="replace") if data.value else ""
    if data.value: x.XFree(data)
    return out
def clients():
    focus, revert = C.c_ulong(), C.c_int()
    x.XGetInputFocus(d, C.byref(focus), C.byref(revert))
    active = prop(root, "_NET_ACTIVE_WINDOW")
    out = []
    for w in prop(root, "_NET_CLIENT_LIST"):
        r, a, b, width, height, border, depth = C.c_ulong(), C.c_int(), C.c_int(), C.c_uint(), C.c_uint(), C.c_uint(), C.c_uint()
        x.XGetGeometry(d, w, C.byref(r), C.byref(a), C.byref(b), C.byref(width), C.byref(height), C.byref(border), C.byref(depth))
        out.append(dict(id=w, role=prop(w, "WM_WINDOW_ROLE"), name=prop(w, "_NET_WM_NAME"), type=prop(w, "_NET_WM_WINDOW_TYPE"), width=width.value, height=height.value, focused=focus.value==w or w in active))
    return out
dialog = x.XInternAtom(d, b"_NET_WM_WINDOW_TYPE_DIALOG", 0)
if "--dialog" in sys.argv or "--no-dialog" in sys.argv:
    x.XSelectInput(d, root, 1 << 22); x.XFlush(d)
    sel = selectors.DefaultSelector(); sel.register(x.XConnectionNumber(d), selectors.EVENT_READ)
    end = time.monotonic() + 12
    while True:
        result = clients()
        found = [c for c in result if dialog in c["type"]]
        if ("--dialog" in sys.argv and any(c["focused"] for c in found)) or ("--no-dialog" in sys.argv and not found): break
        if not x.XPending(d) and not sel.select(max(0, end-time.monotonic())): raise RuntimeError("native dialog condition not reached")
        event = (C.c_long * 24)()
        x.XNextEvent(d, C.byref(event))
else:
    result = clients()
print(json.dumps(result), flush=True)
