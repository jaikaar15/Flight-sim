// Slipstream — native macOS host (JavaScript for Automation + Cocoa/WebKit bridge).
// Opens a native window with a GPU-accelerated WKWebView running the game from
// the app bundle's Resources/game folder. WebGL 2 renders through Metal.
ObjC.import('Cocoa');
ObjC.import('WebKit');

var win = null, web = null, handler = null, wdel = null, dbg = null, dbgTimer = null, dbgDir = null;
var LOG = $.NSHomeDirectory().js + '/Library/Logs/Slipstream.log';

// Debug builds only (Resources/debug.flag present): poll <dir>/cmd.js and run it in the page.
ObjC.registerSubclass({
  name: 'SlipstreamDebug', superclass: 'NSObject',
  methods: {
    'tick:': {
      types: ['void', ['id']],
      implementation: function (t) {
        var fm = $.NSFileManager.defaultManager, p = dbgDir + '/cmd.js';
        if (!fm.fileExistsAtPath(p)) return;
        var js = $.NSString.stringWithContentsOfFileEncodingError(p, 4, null);
        fm.removeItemAtPathError(p, null);
        if (js && !js.isNil()) web.evaluateJavaScriptCompletionHandler(js, null);
      }
    }
  }
});
function writeDbg(name, b64) {
  try { var d = $.NSData.alloc.initWithBase64EncodedStringOptions(b64, 0); d.writeToFileAtomically(dbgDir + '/' + name, true); } catch (e) { log('shot failed ' + e); }
}

function log(s) {
  try {
    var line = $.NSString.alloc.initWithUTF8String(new Date().toISOString() + ' ' + String(s) + '\n');
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(LOG)) line.writeToFileAtomicallyEncodingError(LOG, true, 4, null);
    else {
      var fh = $.NSFileHandle.fileHandleForWritingAtPath(LOG);
      fh.seekToEndOfFile; fh.writeData(line.dataUsingEncoding(4)); fh.closeFile;
    }
  } catch (e) { }
}

ObjC.registerSubclass({
  name: 'SlipstreamBridge', superclass: 'NSObject', protocols: ['WKScriptMessageHandler'],
  methods: {
    'userContentController:didReceiveScriptMessage:': {
      types: ['void', ['id', 'id']],
      implementation: function (ucc, msg) {
        var body = ObjC.unwrap(msg.body), m = {};
        try { m = JSON.parse(body); } catch (e) { m = { cmd: 'log', text: String(body) }; }
        if (m.cmd === 'quit') $.NSApplication.sharedApplication.terminate(null);
        else if (m.cmd === 'fullscreen') win.toggleFullScreen(null);
        else if (m.cmd === 'log') log(m.text);
        else if (m.cmd === 'shot' && dbgDir) writeDbg(m.name || 'shot.jpg', m.data);
      }
    }
  }
});

ObjC.registerSubclass({
  name: 'SlipstreamWindowDelegate', superclass: 'NSObject', protocols: ['NSWindowDelegate'],
  methods: {
    'windowWillClose:': { types: ['void', ['id']], implementation: function (n) { $.NSApplication.sharedApplication.terminate(null); } }
  }
});

function run() {
  var app = $.NSApplication.sharedApplication;
  var res = $.NSBundle.mainBundle.resourcePath.js;
  var gameDir = res + '/game';

  var cfg = $.WKWebViewConfiguration.alloc.init;
  handler = $.SlipstreamBridge.alloc.init;
  cfg.userContentController.addScriptMessageHandlerName(handler, 'native');
  try { cfg.mediaTypesRequiringUserActionForPlayback = 0; } catch (e) { }
  try { cfg.preferences.setValueForKey($.NSNumber.numberWithBool(true), 'developerExtrasEnabled'); } catch (e) { }
  try { cfg.preferences.setValueForKey($.NSNumber.numberWithBool(true), 'fullScreenEnabled'); } catch (e) { }

  var scr = $.NSScreen.mainScreen.visibleFrame;
  var W = Math.min(1600, Math.round(scr.size.width * 0.9)), H = Math.min(1000, Math.round(scr.size.height * 0.9));
  var rect = $.NSMakeRect(0, 0, W, H);
  // titled | closable | miniaturizable | resizable | fullSizeContentView
  win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(rect, 1 | 2 | 4 | 8 | (1 << 15), $.NSBackingStoreBuffered, false);
  win.title = 'Slipstream';
  win.titlebarAppearsTransparent = true;
  win.titleVisibility = 1;
  win.backgroundColor = $.NSColor.blackColor;
  win.minSize = $.NSMakeSize(960, 600);
  win.collectionBehavior = 1 << 7; // full screen primary
  win.releasedWhenClosed = false;

  web = $.WKWebView.alloc.initWithFrameConfiguration(rect, cfg);
  web.autoresizingMask = 2 | 16; // width | height sizable
  try { web.inspectable = true; } catch (e) { }
  try { web.setValueForKey($.NSNumber.numberWithBool(false), 'drawsBackground'); } catch (e) { }
  win.contentView = web;
  wdel = $.SlipstreamWindowDelegate.alloc.init;
  win.delegate = wdel;

  web.loadFileURLAllowingReadAccessToURL($.NSURL.fileURLWithPath(gameDir + '/index.html'), $.NSURL.fileURLWithPath(gameDir));
  win.center;
  win.makeKeyAndOrderFront(null);
  win.makeFirstResponder(web);
  app.activateIgnoringOtherApps(true);
  log('Slipstream started — ' + W + 'x' + H);
  var flag = res + '/debug.flag';
  if ($.NSFileManager.defaultManager.fileExistsAtPath(flag)) {
    dbgDir = $.NSString.stringWithContentsOfFileEncodingError(flag, 4, null).js.replace(/\s+$/, '');
    dbg = $.SlipstreamDebug.alloc.init;
    dbgTimer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.4, dbg, 'tick:', null, true);
    log('debug channel at ' + dbgDir);
  }
}
