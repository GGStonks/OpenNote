// OpenNote iOS shell.
//
// A minimal native host for the OpenNote web app that can be compiled on Linux (clang + ld64.lld +
// an iPhoneOS SDK) without Xcode. It replaces the stub binary of v1.0's release script, which had no
// app delegate and no web view and therefore could not show the app.
//
//  - Serves the bundled web app from <App>.app/public through the custom scheme opennote://app/
//    (module scripts, Web Workers, WebAssembly and IndexedDB need a real origin, not file://).
//  - Exposes window.webkit.messageHandlers.opennote (reply handler) for:
//      http   native NSURLSession requests (the Qwen3-VL server is plain http on LAN/Tailscale,
//             which a WebView would block as mixed content / CORS),
//      share  writes an exported file and opens the share sheet (Save to Files, AirDrop, ...),
//      print  prints the web view (print layout) -> "Save to Files" gives a PDF.
//      pdfPage the print layout as a PDF without the dialog (PDF export); printPdf prints a PDF.
//      haptic UIImpactFeedbackGenerator tick (smart-pen snapping).
//  - Apple Pencil double-tap is forwarded as the DOM event "opennote:pencilDoubleTap".
//  - 240 Hz Pencil input: WKWebView delivers pointer events once per display frame and has no
//    getCoalescedEvents, so the window (ONWindow sendEvent:, ahead of all gesture recognizers and
//    without changing the event) forwards every coalesced UITouch sample (precise location, force, altitude, azimuth,
//    timestamp) to window.__opennotePencil (src/ink/nativePencil.ts); the app models and predicts
//    the ink itself.
//  - iPadOS Scribble is removed from the web view: it holds back Pencil strokes while deciding
//    whether they are handwriting for a text field, which dropped/delayed ink on the canvas.
//  - Full refresh rate: while the screen is touched, a display link asks for the display's maximum
//    rate (120 Hz on ProMotion iPads, nothing to do on 60 Hz ones). WebKit's "near 60 fps" page
//    rendering is lifted only where the display is faster than 60 Hz (kPageRateKey "auto"): lifted
//    on a 60 Hz iPad it left every page drawing at 30 fps. If the page then measures under 50 fps
//    (src/services/frameRate.ts), it says so (kPageUnlockFailedKey) and the next start keeps the cap.
//  - Pinch zoom at the display's rate (ONPinchOverlay): WebKit draws the page at 30 fps in Low Power
//    Mode or when the iPad is hot, so while two fingers zoom the shell shows a snapshot of the
//    canvas and scales it itself (src/editor/nativePinch.ts).
//  - JS alert/confirm/prompt panels and microphone permission (audio notes) are implemented.

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>

static NSString *const kScheme = @"opennote";
static NSString *const kHost = @"app";
static NSString *const kVersion = @"2.7.3";
/** NSUserDefaults: the page's frame rate, "auto" (default), "60" or "max" (Settings > Diagnostics; next start). */
static NSString *const kPageRateKey = @"OpenNotePageRate";
/** NSUserDefaults: lifting the cap left the page under 50 fps here ("auto" keeps the cap since). */
static NSString *const kPageUnlockFailedKey = @"OpenNotePageUnlockFailed";
/** Before 2.3.13: the "unlocked page frame rate" switch (on = "max"). */
static NSString *const kPage120Key = @"OpenNotePage120Hz";
/** NSUserDefaults: the UI theme's background ("#RRGGBB", setLaunchTheme), shown until the page paints. */
static NSString *const kLaunchColorKey = @"OpenNoteLaunchColor";

/** The app's theme background (the system's before the app has sent one): window and web view at start. */
static UIColor *ONLaunchColor(void) {
    NSString *hex = [[NSUserDefaults standardUserDefaults] stringForKey:kLaunchColorKey];
    unsigned int rgb = 0;
    if (hex.length == 7 && [hex hasPrefix:@"#"] && [[NSScanner scannerWithString:[hex substringFromIndex:1]] scanHexInt:&rgb]) {
        return [UIColor colorWithRed:((rgb >> 16) & 255) / 255.0 green:((rgb >> 8) & 255) / 255.0 blue:(rgb & 255) / 255.0 alpha:1];
    }
    return [UIColor systemGroupedBackgroundColor];
}

@interface ONFrameRateBooster : NSObject
- (void)poke;
@end

@interface ONInkView : UIView
@property (nonatomic, readonly) BOOL active;
- (void)handleMessage:(NSString *)msg;
- (void)leadTo:(CGPoint)p;
- (void)dropLead;
- (void)touchEnded;
@end

#pragma mark - 240 Hz Apple Pencil samples

// The samples are taken in the window's sendEvent:, which every touch event passes through before
// any gesture recognizer. v1.7 used a passive gesture recognizer on the web view instead, but
// WebKit fails the web view's other recognizers once the page handles the touch (preventDefault on
// pointerdown, ~10 ms later): the recognizer stopped receiving samples and every stroke was cut
// off after its first few milliseconds.
@interface ONWindow : UIWindow
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, strong) ONFrameRateBooster *booster;
@property (nonatomic, weak) ONInkView *inkView;
@end

@implementation ONWindow {
    __weak UITouch *_pencil;
}

static void ONAppendTouch(NSMutableString *js, UITouch *t, UIView *view) {
    CGPoint p = [t preciseLocationInView:view];
    CGFloat maxForce = t.maximumPossibleForce > 0 ? t.maximumPossibleForce : 1;
    [js appendFormat:@"%.3f,%.3f,%.4f,%.5f,%.4f,%.4f,", p.x, p.y, t.force / maxForce, t.timestamp,
                     t.altitudeAngle, [t azimuthAngleInView:view]];
}

- (void)sendEvent:(UIEvent *)event {
    if (event.type == UIEventTypeTouches) {
        [self.booster poke];
        if (self.webView) [self forwardPencil:event];
    }
    [super sendEvent:event];
}

// phase: 0 began, 1 moved, 2 ended, 3 cancelled. Samples: x, y, force 0..1, time (s), altitude, azimuth.
- (void)forwardPencil:(UIEvent *)event {
    WKWebView *view = self.webView;
    for (UITouch *touch in event.allTouches) {
        if (touch.type != UITouchTypePencil) continue;
        int phase;
        switch (touch.phase) {
            case UITouchPhaseBegan: phase = 0; break;
            case UITouchPhaseMoved: phase = 1; break;
            case UITouchPhaseEnded: phase = 2; break;
            case UITouchPhaseCancelled: phase = 3; break;
            default: continue; // stationary, hover
        }
        if (phase == 0) {
            // Only touches on the web content (not on a share sheet or an alert over it).
            UIView *hit = touch.view ?: [self hitTest:[touch locationInView:self] withEvent:event];
            if (![hit isDescendantOfView:view]) continue;
            _pencil = touch;
        } else if (touch != _pencil) {
            continue;
        }
        NSMutableString *js = [NSMutableString stringWithFormat:@"window.__opennotePencil&&window.__opennotePencil(%d,%.5f,[",
                                                                phase, [NSProcessInfo processInfo].systemUptime];
        NSArray<UITouch *> *samples = [event coalescedTouchesForTouch:touch];
        if (!samples.count) samples = @[ touch ];
        for (UITouch *t in samples) ONAppendTouch(js, t, view);
        // No predictedTouches: the web app's ink engine (src/ink/nib.ts) predicts the pen itself.
        [js appendString:@"],[])"];
        [view evaluateJavaScript:js completionHandler:nil];
        // Native live ink: the line reaches the pen's newest position now, not after the page. Not
        // to samples without force: the Pencil leaving the glass, which the ink engine leaves out of
        // the ink (the line ends where it lifted); drawing the lead to them made the ink overshoot
        // past its end until the page took the stroke over. Nor to an older sample once one without
        // force came: the line runs on past it, and the lead back to it showed as a chord. The page
        // keeps the same lead (src/ink/nativePencil.ts): its finished stroke ends there.
        ONInkView *ink = self.inkView;
        UITouch *newest = samples.lastObject;
        CGFloat maxForce = newest.maximumPossibleForce > 0 ? newest.maximumPossibleForce : 1;
        if (ink.active && phase == 1) {
            if (newest.force / maxForce > 0.02) [ink leadTo:[newest preciseLocationInView:view]];
            else [ink dropLead];
        }
        if (phase >= 2) {
            _pencil = nil;
            [ink touchEnded];
        }
    }
}

@end

#pragma mark - Bundled web app over opennote://app/

@interface ONSchemeHandler : NSObject <WKURLSchemeHandler>
@property (nonatomic, copy) NSString *root;
@end

@implementation ONSchemeHandler

static NSString *ONMimeType(NSString *ext) {
    static NSDictionary<NSString *, NSString *> *map;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        map = @{
            @"html": @"text/html", @"js": @"text/javascript", @"mjs": @"text/javascript", @"css": @"text/css",
            @"json": @"application/json", @"svg": @"image/svg+xml", @"png": @"image/png", @"jpg": @"image/jpeg",
            @"jpeg": @"image/jpeg", @"gif": @"image/gif", @"webp": @"image/webp", @"ico": @"image/x-icon",
            @"woff": @"font/woff", @"woff2": @"font/woff2", @"ttf": @"font/ttf", @"otf": @"font/otf",
            @"wasm": @"application/wasm", @"gzb": @"application/octet-stream", @"gz": @"application/octet-stream",
            @"txt": @"text/plain", @"map": @"application/json",
        };
    });
    return map[ext.lowercaseString] ?: @"application/octet-stream";
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *path = url.path.length > 1 ? url.path : @"/index.html";
    path = [path stringByRemovingPercentEncoding] ?: path;
    NSString *file = [[self.root stringByAppendingPathComponent:path] stringByStandardizingPath];

    NSData *data = nil;
    BOOL isDir = NO;
    // Never serve anything outside the bundled web root.
    if ([file hasPrefix:self.root] && [[NSFileManager defaultManager] fileExistsAtPath:file isDirectory:&isDir] && !isDir) {
        data = [NSData dataWithContentsOfFile:file];
    }
    NSInteger status = data ? 200 : 404;
    if (!data) data = [NSData data];
    NSDictionary *headers = @{
        @"Content-Type": ONMimeType(file.pathExtension),
        @"Content-Length": [NSString stringWithFormat:@"%lu", (unsigned long)data.length],
        @"Cache-Control": @"no-cache",
        @"Access-Control-Allow-Origin": @"*",
    };
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:headers];
    [task didReceiveResponse:response];
    [task didReceiveData:data];
    [task didFinish];
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
}

@end

#pragma mark - Full display refresh rate

// WebKit runs requestAnimationFrame, and with it the app's scrolling, momentum and live ink, at
// 60 fps even on a 120 Hz ProMotion display: the internal feature "Prefer Page Rendering Updates
// near 60fps" (Safari > Feature Flags) is on by default. It is switched off through WebKit's
// feature-flag SPI, whose spelling changed between iOS versions; each form is tried and checked at
// runtime. Returns YES if the flag was found and turned off. The key is matched loosely too
// ("...Near60FPS..."), as WebKit has renamed flags before.
static BOOL ONEnableFullFrameRate(WKPreferences *prefs) {
    NSString *const key = @"PreferPageRenderingUpdatesNear60FPSEnabled";
    NSArray<NSArray<NSString *> *> *spis = @[
        @[ @"_features", @"_setEnabled:forFeature:" ],
        @[ @"_internalDebugFeatures", @"_setEnabled:forInternalDebugFeature:" ],
        @[ @"_experimentalFeatures", @"_setEnabled:forExperimentalFeature:" ],
    ];
    for (NSArray<NSString *> *spi in spis) {
        SEL list = NSSelectorFromString(spi[0]), set = NSSelectorFromString(spi[1]);
        if (![WKPreferences respondsToSelector:list] || ![prefs respondsToSelector:set]) continue;
        NSArray *features = ((NSArray * (*)(id, SEL))objc_msgSend)([WKPreferences class], list);
        id loose = nil;
        for (id feature in features) {
            NSString *featureKey = nil;
            @try {
                featureKey = [feature valueForKey:@"key"];
            } @catch (NSException *e) {
                continue;
            }
            if (![featureKey isKindOfClass:[NSString class]]) continue;
            if ([featureKey isEqualToString:key]) {
                ((void (*)(id, SEL, BOOL, id))objc_msgSend)(prefs, set, NO, feature);
                return YES;
            }
            if (!loose && [featureKey rangeOfString:@"Near60FPS" options:NSCaseInsensitiveSearch].location != NSNotFound) loose = feature;
        }
        if (loose) {
            ((void (*)(id, SEL, BOOL, id))objc_msgSend)(prefs, set, NO, loose);
            return YES;
        }
    }
    return NO;
}

/** The fastest refresh rate of the device's display: 60 on most iPads, 120 on ProMotion ones. */
static NSInteger ONMaxFramesPerSecond(void) {
    NSInteger fps = [UIScreen mainScreen].maximumFramesPerSecond;
    return fps > 0 ? fps : 60;
}

// A ProMotion panel runs at the highest rate any client asks for and drops to a low rate when
// nothing does, so WebKit's own requests are backed up by the shell's. While a finger or the Pencil is on the screen, and for a few seconds after (scroll
// momentum, the ink settling), a display link asks for the display's maximum rate. On a 60 Hz
// iPad there is nothing to raise and the link is never created.
@implementation ONFrameRateBooster {
    CADisplayLink *_link;
    CFTimeInterval _until;
    NSInteger _maxFps;
}

static const CFTimeInterval kBoostLinger = 3.0;

- (instancetype)init {
    if ((self = [super init])) _maxFps = ONMaxFramesPerSecond();
    return self;
}

- (void)poke {
    if (_maxFps <= 60) return;
    _until = CACurrentMediaTime() + kBoostLinger;
    if (_link) return;
    _link = [CADisplayLink displayLinkWithTarget:self selector:@selector(tick:)];
    if ([_link respondsToSelector:@selector(setPreferredFrameRateRange:)]) {
        float max = (float)_maxFps;
        _link.preferredFrameRateRange = CAFrameRateRangeMake(max, max, max);
    } else {
        _link.preferredFramesPerSecond = _maxFps;
    }
    [_link addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
}

- (void)tick:(CADisplayLink *)link {
    if (CACurrentMediaTime() < _until) return;
    [_link invalidate];
    _link = nil;
}

@end

#pragma mark - Native live ink

// The stroke being written, drawn natively above the web view (src/ink/nativeInk.ts): the page
// sends the ink engine's modelled points as it models them, and this layer shows them without
// waiting for the web view's rendering (its next frame, paint and layer hand-off), which made the
// pen trail visibly on 60 Hz iPads. The geometry is the engine's (src/ink/engine/geometry.ts,
// addCapsule): fountain pen = union of capsules between consecutive points (nonzero fill, all
// wound the same way), ballpoint = round-capped line. The page keeps drawing the stroke too and
// says when its own copy is on screen ("e"); only then is this layer cleared.

typedef struct { CGFloat x, y, r; } ONInkPt;

/** One capsule exactly as addCapsule draws it (angles decreasing = canvas anticlockwise). */
static void ONAddCapsule(CGMutablePathRef path, ONInkPt a, ONInkPt b) {
    CGFloat dx = b.x - a.x, dy = b.y - a.y, d = hypot(dx, dy);
    if (d <= fabs(a.r - b.r) + 1e-6) {
        ONInkPt c = a.r >= b.r ? a : b;
        CGPathMoveToPoint(path, NULL, c.x + c.r, c.y);
        CGPathAddArc(path, NULL, c.x, c.y, c.r, 0, -M_PI, YES);
        CGPathAddArc(path, NULL, c.x, c.y, c.r, -M_PI, -2 * M_PI, YES);
        CGPathCloseSubpath(path);
        return;
    }
    CGFloat th = atan2(dy, dx), ph = acos((a.r - b.r) / d);
    CGPathMoveToPoint(path, NULL, a.x + a.r * cos(th + ph), a.y + a.r * sin(th + ph));
    CGPathAddLineToPoint(path, NULL, b.x + b.r * cos(th + ph), b.y + b.r * sin(th + ph));
    CGPathAddArc(path, NULL, b.x, b.y, b.r, th + ph, th - ph, YES);
    CGPathAddLineToPoint(path, NULL, a.x + a.r * cos(th - ph), a.y + a.r * sin(th - ph));
    CGPathAddArc(path, NULL, a.x, a.y, a.r, th - ph, th + ph - 2 * M_PI, YES);
    CGPathCloseSubpath(path);
}

/** Settled ink is split into layers of this many points: a full one is never redrawn. */
static const NSUInteger kInkChunk = 64;

/**
 * A whole live drawing (Draw tool shapes, snapped pen shapes, the snap dot) replayed from the
 * page's drawing commands (src/ink/inkRecorder.ts) with Core Graphics: what the page's canvas
 * draws, call for call. Only the area that changed is redrawn.
 */
@interface ONSceneView : UIView
- (void)showCommands:(NSArray<NSString *> *)tokens from:(NSUInteger)start clip:(CGRect)clip;
- (void)clearScene;
@end

@implementation ONSceneView {
    NSArray<NSString *> *_tokens;
    NSUInteger _start;
    CGRect _clip, _shown;
}

- (instancetype)initWithFrame:(CGRect)frame {
    if ((self = [super initWithFrame:frame])) {
        self.userInteractionEnabled = NO;
        self.opaque = NO;
        self.backgroundColor = UIColor.clearColor;
        self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        self.contentMode = UIViewContentModeRedraw;
        _shown = CGRectNull;
    }
    return self;
}

/** Bounds of every coordinate in the commands, padded by the widest line. */
static CGRect ONSceneBounds(NSArray<NSString *> *t, NSUInteger i) {
    __block CGFloat minX = INFINITY, minY = INFINITY, maxX = -INFINITY, maxY = -INFINITY;
    CGFloat pad = 2;
    void (^add)(CGFloat, CGFloat, CGFloat) = ^(CGFloat x, CGFloat y, CGFloat r) {
        minX = MIN(minX, x - r); minY = MIN(minY, y - r); maxX = MAX(maxX, x + r); maxY = MAX(maxY, y + r);
    };
    NSUInteger n = t.count;
    while (i < n) {
        NSString *op = t[i++];
        unichar c = op.length ? [op characterAtIndex:0] : 0;
        switch (c) {
            case 'M': case 'L': if (i + 1 < n) add(t[i].doubleValue, t[i + 1].doubleValue, 0); i += 2; break;
            case 'Q': for (int k = 0; k < 2 && i + 1 < n; k++, i += 2) add(t[i].doubleValue, t[i + 1].doubleValue, 0); break;
            case 'C': for (int k = 0; k < 3 && i + 1 < n; k++, i += 2) add(t[i].doubleValue, t[i + 1].doubleValue, 0); break;
            case 'E': if (i + 2 < n) add(t[i].doubleValue, t[i + 1].doubleValue, t[i + 2].doubleValue); i += 6; break;
            case 'X': if (i + 3 < n) { add(t[i].doubleValue, t[i + 1].doubleValue, 0); add(t[i].doubleValue + t[i + 2].doubleValue, t[i + 1].doubleValue + t[i + 3].doubleValue, 0); } i += 4; break;
            case 'W': if (i < n) pad = MAX(pad, t[i].doubleValue + 2); i += 1; break;
            case 'F': case 'K': i += 4; break;
            case 'A': case 'f': case 'x': i += 1; break;
            case 'P': i += 2; break;
            case 'D': { NSUInteger cnt = i < n ? (NSUInteger)MAX(0, t[i].integerValue) : 0; i += cnt + 2; break; }
            default: break;
        }
    }
    if (minX > maxX) return CGRectNull;
    return CGRectInset(CGRectMake(minX, minY, maxX - minX, maxY - minY), -pad, -pad);
}

- (void)showCommands:(NSArray<NSString *> *)tokens from:(NSUInteger)start clip:(CGRect)clip {
    CGRect now = CGRectIntersection(ONSceneBounds(tokens, start), clip);
    CGRect dirty = CGRectUnion(_shown, now);
    _tokens = tokens;
    _start = start;
    _clip = clip;
    _shown = now;
    if (!CGRectIsNull(dirty)) [self setNeedsDisplayInRect:CGRectIntegral(dirty)];
}

- (void)clearScene {
    if (!_tokens) return;
    _tokens = nil;
    if (!CGRectIsNull(_shown)) [self setNeedsDisplayInRect:CGRectIntegral(_shown)];
    _shown = CGRectNull;
}

static CGColorRef ONColor(NSArray<NSString *> *t, NSUInteger i) {
    return [UIColor colorWithRed:t[i].doubleValue / 255 green:t[i + 1].doubleValue / 255 blue:t[i + 2].doubleValue / 255 alpha:t[i + 3].doubleValue].CGColor;
}

/** canvas arc(): a sweep of 2pi or more is a full circle; otherwise CG's own arc (same direction convention). */
static void ONArc(CGMutablePathRef p, CGFloat cx, CGFloat cy, CGFloat r, CGFloat a0, CGFloat a1, BOOL ccw) {
    if (fabs(a1 - a0) >= 2 * M_PI - 1e-4) {
        CGFloat dir = ccw ? -1 : 1;
        CGPoint start = CGPointMake(cx + r * cos(a0), cy + r * sin(a0));
        if (CGPathIsEmpty(p)) CGPathMoveToPoint(p, NULL, start.x, start.y);
        else CGPathAddLineToPoint(p, NULL, start.x, start.y);
        CGPathAddArc(p, NULL, cx, cy, r, a0, a0 + dir * M_PI, ccw);
        CGPathAddArc(p, NULL, cx, cy, r, a0 + dir * M_PI, a0 + dir * 2 * M_PI, ccw);
        return;
    }
    CGPathAddArc(p, NULL, cx, cy, r, a0, a1, ccw);
}

- (void)drawRect:(CGRect)rect {
    NSArray<NSString *> *t = _tokens;
    if (!t) return;
    CGContextRef g = UIGraphicsGetCurrentContext();
    CGContextSaveGState(g);
    CGContextClipToRect(g, _clip);
    CGMutablePathRef path = CGPathCreateMutable();
    NSUInteger i = _start, n = t.count;
    static const CGLineCap caps[] = { kCGLineCapButt, kCGLineCapRound, kCGLineCapSquare };
    static const CGLineJoin joins[] = { kCGLineJoinMiter, kCGLineJoinRound, kCGLineJoinBevel };
    while (i < n) {
        NSString *op = t[i++];
        unichar c = op.length ? [op characterAtIndex:0] : 0;
        switch (c) {
            case 'S': CGContextSaveGState(g); break;
            case 'R': CGContextRestoreGState(g); break;
            case 'F': if (i + 3 < n) CGContextSetFillColorWithColor(g, ONColor(t, i)); i += 4; break;
            case 'K': if (i + 3 < n) CGContextSetStrokeColorWithColor(g, ONColor(t, i)); i += 4; break;
            case 'A': if (i < n) CGContextSetAlpha(g, t[i].doubleValue); i += 1; break;
            case 'W': if (i < n) CGContextSetLineWidth(g, t[i].doubleValue); i += 1; break;
            case 'P': if (i + 1 < n) { CGContextSetLineCap(g, caps[MIN(2, MAX(0, t[i].intValue))]); CGContextSetLineJoin(g, joins[MIN(2, MAX(0, t[i + 1].intValue))]); } i += 2; break;
            case 'D': {
                NSUInteger cnt = i < n ? (NSUInteger)MAX(0, t[i].integerValue) : 0;
                if (i + cnt + 1 >= n) { i = n; break; }
                CGFloat lengths[16];
                NSUInteger m = MIN(cnt, (NSUInteger)16);
                for (NSUInteger k = 0; k < m; k++) lengths[k] = t[i + 1 + k].doubleValue;
                CGContextSetLineDash(g, t[i + 1 + cnt].doubleValue, m ? lengths : NULL, m);
                i += cnt + 2;
                break;
            }
            case 'N': CGPathRelease(path); path = CGPathCreateMutable(); break;
            case 'M': if (i + 1 < n) CGPathMoveToPoint(path, NULL, t[i].doubleValue, t[i + 1].doubleValue); i += 2; break;
            case 'L':
                if (i + 1 < n) {
                    if (CGPathIsEmpty(path)) CGPathMoveToPoint(path, NULL, t[i].doubleValue, t[i + 1].doubleValue);
                    else CGPathAddLineToPoint(path, NULL, t[i].doubleValue, t[i + 1].doubleValue);
                }
                i += 2;
                break;
            case 'Q': if (i + 3 < n && !CGPathIsEmpty(path)) CGPathAddQuadCurveToPoint(path, NULL, t[i].doubleValue, t[i + 1].doubleValue, t[i + 2].doubleValue, t[i + 3].doubleValue); i += 4; break;
            case 'C': if (i + 5 < n && !CGPathIsEmpty(path)) CGPathAddCurveToPoint(path, NULL, t[i].doubleValue, t[i + 1].doubleValue, t[i + 2].doubleValue, t[i + 3].doubleValue, t[i + 4].doubleValue, t[i + 5].doubleValue); i += 6; break;
            case 'E': if (i + 5 < n) ONArc(path, t[i].doubleValue, t[i + 1].doubleValue, t[i + 2].doubleValue, t[i + 3].doubleValue, t[i + 4].doubleValue, t[i + 5].intValue != 0); i += 6; break;
            case 'X': if (i + 3 < n) CGPathAddRect(path, NULL, CGRectMake(t[i].doubleValue, t[i + 1].doubleValue, t[i + 2].doubleValue, t[i + 3].doubleValue)); i += 4; break;
            case 'Z': if (!CGPathIsEmpty(path)) CGPathCloseSubpath(path); break;
            case 'f':
                CGContextAddPath(g, path);
                if (i < n && t[i].intValue == 1) CGContextEOFillPath(g); else CGContextFillPath(g);
                i += 1;
                break;
            case 's': CGContextAddPath(g, path); CGContextStrokePath(g); break;
            case 'x':
                CGContextAddPath(g, path);
                if (i < n && t[i].intValue == 1) CGContextEOClip(g); else CGContextClip(g);
                i += 1;
                break;
            default: break;
        }
    }
    CGPathRelease(path);
    CGContextRestoreGState(g);
}

@end

@implementation ONInkView {
    CALayer *_clip;
    NSMutableArray<CAShapeLayer *> *_chunks;
    CAShapeLayer *_tail, *_lead;
    NSMutableData *_settled; // ONInkPt
    NSUInteger _chunkStart;  // index of the open chunk's first point
    NSMutableData *_tailPts;
    BOOL _variable;
    CGColorRef _color;
    BOOL _hasRaw;
    CGPoint _raw;
    /** The pen lifted from the stroke shown: the next touch's samples are not its lead. */
    BOOL _lifted;
    NSUInteger _generation;
    ONSceneView *_scene;
    /** The page's id of the stroke shown ("b"'s last field; 0: none or a drawing). */
    NSInteger _currentId;
    /** Finished strokes kept on screen while the next is written, until their own "e,id". */
    NSMutableDictionary<NSNumber *, CALayer *> *_retired;
}

/**
 * A finished stroke stays this long after the page says its own copy is drawn ("e"): that copy
 * reaches the screen a frame or two after the page's frame (it is composited by other processes),
 * and clearing at once let the stroke blink out and back, at 60 fps above all.
 */
static const double kInkHoldSeconds = 0.06;

- (instancetype)initWithFrame:(CGRect)frame {
    if ((self = [super initWithFrame:frame])) {
        self.userInteractionEnabled = NO;
        self.backgroundColor = UIColor.clearColor;
        self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        _clip = [CALayer layer];
        _clip.masksToBounds = YES;
        [self.layer addSublayer:_clip];
        _scene = [[ONSceneView alloc] initWithFrame:self.bounds];
        [self addSubview:_scene];
        _chunks = [NSMutableArray array];
        _retired = [NSMutableDictionary dictionary];
        _settled = [NSMutableData data];
        _tailPts = [NSMutableData data];
    }
    return self;
}

- (void)dealloc {
    if (_color) CGColorRelease(_color);
}

- (CAShapeLayer *)newShape {
    CAShapeLayer *l = [CAShapeLayer layer];
    l.contentsScale = UIScreen.mainScreen.scale;
    if (_variable) {
        l.fillColor = _color;
        l.strokeColor = NULL;
    } else {
        l.fillColor = NULL;
        l.strokeColor = _color;
        l.lineCap = kCALineCapRound;
        l.lineJoin = kCALineJoinRound;
    }
    [_clip addSublayer:l];
    return l;
}

/** Path through pts[0..n): capsules (fountain pen) or a polyline (ballpoint, stroked 2r wide). */
- (CGPathRef)newPath:(const ONInkPt *)pts count:(NSUInteger)n width:(CGFloat *)width {
    CGMutablePathRef path = CGPathCreateMutable();
    if (!n) return path;
    if (_variable) {
        if (n == 1) ONAddCapsule(path, pts[0], pts[0]);
        for (NSUInteger i = 1; i < n; i++) ONAddCapsule(path, pts[i - 1], pts[i]);
    } else {
        CGPathMoveToPoint(path, NULL, pts[0].x, pts[0].y);
        if (n == 1) CGPathAddLineToPoint(path, NULL, pts[0].x + 0.01, pts[0].y);
        for (NSUInteger i = 1; i < n; i++) CGPathAddLineToPoint(path, NULL, pts[i].x, pts[i].y);
    }
    if (width) *width = pts[n - 1].r * 2;
    return path;
}

- (void)setShape:(CAShapeLayer *)layer points:(const ONInkPt *)pts count:(NSUInteger)n {
    CGFloat w = 0;
    CGPathRef path = [self newPath:pts count:n width:&w];
    layer.path = path;
    if (!_variable) layer.lineWidth = w;
    CGPathRelease(path);
}

- (void)clear {
    for (CAShapeLayer *l in _chunks) [l removeFromSuperlayer];
    [_chunks removeAllObjects];
    [_tail removeFromSuperlayer];
    [_lead removeFromSuperlayer];
    _tail = _lead = nil;
    _settled.length = 0;
    _tailPts.length = 0;
    _chunkStart = 0;
    _hasRaw = NO;
    _active = NO;
    [_scene clearScene];
}

/**
 * The next stroke begins while this one is still shown: it stays on screen, in a layer of its own,
 * until its own "e,id" (clearing it here, before the page had drawn it, made quick writing blink).
 */
- (void)retire {
    if (!_active || !_currentId || (!_chunks.count && !_tail)) return;
    CALayer *held = [CALayer layer];
    held.frame = _clip.frame;
    held.masksToBounds = YES;
    held.sublayerTransform = _clip.sublayerTransform;
    for (CAShapeLayer *l in _chunks) {
        [l removeFromSuperlayer];
        [held addSublayer:l];
    }
    if (_tail) {
        [_tail removeFromSuperlayer];
        [held addSublayer:_tail];
    }
    // The lead too: the pen lifted where it reaches (the page's stroke ends there, "l").
    if (_lead) {
        [_lead removeFromSuperlayer];
        if (_hasRaw) [held addSublayer:_lead];
    }
    [_chunks removeAllObjects];
    _tail = _lead = nil;
    [self.layer insertSublayer:held below:_clip];
    NSNumber *key = @(_currentId);
    [_retired[key] removeFromSuperlayer];
    _retired[key] = held;
    // Safety net, as touchEnded's.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self->_retired[key] == held) [self releaseStroke:key.integerValue];
    });
}

/** Stroke `sid` is on screen in the page: its ink here goes. */
- (void)releaseStroke:(NSInteger)sid {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    CALayer *held = _retired[@(sid)];
    if (held) {
        [held removeFromSuperlayer];
        [_retired removeObjectForKey:@(sid)];
    } else if (_active && _currentId == sid) {
        _generation++;
        [self clear];
        _currentId = 0;
    }
    [CATransaction commit];
}

- (const ONInkPt *)settled {
    return (const ONInkPt *)_settled.bytes;
}

- (NSUInteger)settledCount {
    return _settled.length / sizeof(ONInkPt);
}

/** The end of the modelled line (where the lead starts). */
- (BOOL)lineEnd:(ONInkPt *)out {
    NSUInteger nt = _tailPts.length / sizeof(ONInkPt), ns = self.settledCount;
    if (nt) *out = ((const ONInkPt *)_tailPts.bytes)[nt - 1];
    else if (ns) *out = self.settled[ns - 1];
    else return NO;
    return YES;
}

- (void)drawLead {
    ONInkPt end;
    if (!_hasRaw || ![self lineEnd:&end]) {
        _lead.path = NULL;
        return;
    }
    if (!_lead) _lead = [self newShape];
    ONInkPt seg[2] = { end, { _raw.x, _raw.y, end.r } };
    [self setShape:_lead points:seg count:2];
}

- (void)leadTo:(CGPoint)p {
    if (_lifted) return;
    _raw = p;
    _hasRaw = YES;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [self drawLead];
    [CATransaction commit];
}

- (void)dropLead {
    if (_lifted || !_hasRaw) return;
    _hasRaw = NO;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    _lead.path = NULL;
    [CATransaction commit];
}

/** The line's last piece (from the last settled point through the provisional tail). */
- (void)drawTail {
    NSUInteger nt = _tailPts.length / sizeof(ONInkPt), ns = self.settledCount;
    if (!_tail) _tail = [self newShape];
    NSMutableData *seq = [NSMutableData dataWithCapacity:(nt + 1) * sizeof(ONInkPt)];
    if (ns) [seq appendBytes:self.settled + ns - 1 length:sizeof(ONInkPt)];
    [seq appendData:_tailPts];
    [self setShape:_tail points:(const ONInkPt *)seq.bytes count:seq.length / sizeof(ONInkPt)];
}

- (void)touchEnded {
    // The pen lifted: the lead stays until the page says where its stroke ends ("l"); dropping it
    // here pulled the ink's end back at every lift (zoomed in, by several px).
    _lifted = YES;
    // Safety net: the page normally clears the layer ("e"); if it never does, do not leave ink.
    NSUInteger gen = _generation;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self->_generation == gen && self->_active) {
            [CATransaction begin];
            [CATransaction setDisableActions:YES];
            [self clear];
            [CATransaction commit];
        }
    });
}

- (void)handleMessage:(NSString *)msg {
    NSArray<NSString *> *f = [msg componentsSeparatedByString:@","];
    if (!f.count) return;
    NSString *kind = f[0];
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    if ([kind isEqualToString:@"b"] && f.count >= 10) {
        // The same id again: the stroke restarts (its style or place changed), nothing to keep.
        NSInteger sid = f.count > 10 ? f[10].integerValue : 0;
        if (sid != _currentId) [self retire];
        [self clear];
        _generation++;
        _currentId = sid;
        _lifted = NO;
        if (_color) CGColorRelease(_color);
        _color = CGColorRetain([UIColor colorWithRed:f[1].doubleValue / 255 green:f[2].doubleValue / 255 blue:f[3].doubleValue / 255 alpha:f[4].doubleValue].CGColor);
        _variable = f[5].intValue != 0;
        _clip.frame = CGRectMake(f[6].doubleValue, f[7].doubleValue, f[8].doubleValue, f[9].doubleValue);
        _clip.sublayerTransform = CATransform3DMakeTranslation(-_clip.frame.origin.x, -_clip.frame.origin.y, 0);
        _active = YES;
    } else if ([kind isEqualToString:@"u"] && _active && f.count >= 2) {
        NSUInteger fresh = (NSUInteger)MAX(0, f[1].integerValue);
        NSUInteger total = (f.count - 2) / 3;
        fresh = MIN(fresh, total);
        for (NSUInteger i = 0; i < total; i++) {
            ONInkPt q = { f[2 + i * 3].doubleValue, f[3 + i * 3].doubleValue, f[4 + i * 3].doubleValue };
            if (i < fresh) [_settled appendBytes:&q length:sizeof q];
            else {
                if (i == fresh) _tailPts.length = 0;
                [_tailPts appendBytes:&q length:sizeof q];
            }
        }
        if (fresh == total) _tailPts.length = 0;
        NSUInteger ns = self.settledCount;
        if (fresh) {
            // The open chunk runs from its first point to the end. Once it holds kInkChunk points it
            // is left as it is, and the next one starts at its last point, so the line continues.
            NSUInteger drawn = ns - fresh;
            if (!_chunks.count) {
                _chunkStart = 0;
                [_chunks addObject:[self newShape]];
            } else if (drawn - _chunkStart >= kInkChunk) {
                _chunkStart = drawn - 1;
                [_chunks addObject:[self newShape]];
            }
            [self setShape:_chunks.lastObject points:self.settled + _chunkStart count:ns - _chunkStart];
        }
        // The tail continues from the last settled point.
        [self drawTail];
        [self drawLead];
    } else if ([kind isEqualToString:@"l"] && _active && f.count >= 2 && f[1].integerValue == _currentId) {
        // The pen lifted and the page's stroke is finished: it runs on to x, y at its end's radius
        // (Stroke.penEnd, where the lead reached), which becomes part of the line; "l,id" alone: it
        // ends where the line ends.
        ONInkPt end;
        if (f.count >= 4 && [self lineEnd:&end]) {
            ONInkPt q = { f[2].doubleValue, f[3].doubleValue, end.r };
            [_tailPts appendBytes:&q length:sizeof q];
            [self drawTail];
        }
        _hasRaw = NO;
        _lead.path = NULL;
    } else if ([kind isEqualToString:@"d"] && f.count >= 5) {
        // A whole drawing: replaces the stroke (a pen stroke that snapped to a shape) or the last drawing.
        BOOL wasScene = _active && !_chunks.count && !_tail;
        if (!wasScene) {
            [self clear];
            _generation++;
        }
        _active = YES;
        CGRect clip = CGRectMake(f[1].doubleValue, f[2].doubleValue, f[3].doubleValue, f[4].doubleValue);
        [_scene showCommands:f from:5 clip:clip];
    } else if ([kind isEqualToString:@"e"] && f.count > 1) {
        NSInteger sid = f[1].integerValue;
        __weak ONInkView *weakSelf = self;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kInkHoldSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [weakSelf releaseStroke:sid];
        });
    } else if ([kind isEqualToString:@"e"] || [kind isEqualToString:@"c"]) {
        _generation++;
        [self clear];
        _currentId = 0;
    }
    [CATransaction commit];
}

@end

#pragma mark - View controller

#pragma mark - Native pinch

// Two fingers zooming the note (src/editor/nativePinch.ts). WebKit renders the page at 30 fps in
// Low Power Mode and under thermal pressure (ThrottlingReason::LowPowerMode / ThermalMitigation,
// read by the web content process itself: no setting turns it off), while native scrolling stays
// at the display's rate; the pinch, drawn by the page, went at half speed. As a native scroll view
// zooms (the rendered content scaled while the fingers move, drawn again once they lift): when the page starts a pinch, a snapshot of the canvas area (what is on screen,
// taken by the system compositor without waiting for the page) is laid over it and scaled on
// every finger event the page forwards; the page draws the new zoom once the fingers lift and then
// says so ("e"), and the snapshot goes. The page stays still under it and the snapshot sits on the
// desk's colour: it is the only picture while the fingers move (the page scaled under it too, at
// its own slower rate, showed out of step beside it).
//
// Messages: b,id,x,y,w,h,c0x,c0y[,r,g,b]   begin: the canvas area (points), the point first between
//                                  the fingers (relative to the area), the desk's colour
//           m,id,k,cx,cy           the scale so far and the point between the fingers now
//           e,id[,k,cx,cy]         the page shows the new zoom: remove (after gliding to the scale
//                                  and place of the first centre the page really has)
@interface ONPinchOverlay : NSObject
- (instancetype)initWithHost:(UIView *)host;
- (void)handleMessage:(NSString *)msg;
@end

@implementation ONPinchOverlay {
    __weak UIView *_host;
    UIView *_clip;
    UIView *_snap;
    CGAffineTransform _base;
    CGPoint _c0;
    NSInteger _id;
    NSTimer *_watchdog;
}

- (instancetype)initWithHost:(UIView *)host {
    if ((self = [super init])) _host = host;
    return self;
}

- (void)remove {
    [_watchdog invalidate];
    _watchdog = nil;
    [_clip removeFromSuperview];
    _clip = nil;
    _snap = nil;
}

// A pinch whose end never arrives (the page reloaded, an error): the page under the snapshot shows
// the same thing, so removing it is safe.
- (void)arm {
    [_watchdog invalidate];
    __weak ONPinchOverlay *weakSelf = self;
    _watchdog = [NSTimer scheduledTimerWithTimeInterval:2.0 repeats:NO block:^(NSTimer *t) { [weakSelf remove]; }];
}

- (void)handleMessage:(NSString *)msg {
    NSArray<NSString *> *t = [msg componentsSeparatedByString:@","];
    if (t.count < 2) return;
    NSString *kind = t[0];
    NSInteger pid = t[1].integerValue;
    UIView *host = _host;
    if ([kind isEqualToString:@"b"] && t.count >= 8 && host) {
        CGRect r = CGRectMake(t[2].doubleValue, t[3].doubleValue, t[4].doubleValue, t[5].doubleValue);
        _c0 = CGPointMake(t[6].doubleValue, t[7].doubleValue);
        _id = pid;
        if (_clip && CGRectEqualToRect(_clip.frame, r)) {
            // A pinch right after the last, before the page drew it: the snapshot is still shown
            // (a new one would contain it); this pinch continues from where it is.
            _base = _snap.transform;
        } else {
            [self remove];
            UIView *snap = [host resizableSnapshotViewFromRect:r afterScreenUpdates:NO withCapInsets:UIEdgeInsetsZero];
            if (!snap) return;
            UIView *clip = [[UIView alloc] initWithFrame:r];
            clip.clipsToBounds = YES;
            clip.userInteractionEnabled = NO;
            clip.backgroundColor = t.count >= 11
                ? [UIColor colorWithRed:t[8].doubleValue / 255 green:t[9].doubleValue / 255 blue:t[10].doubleValue / 255 alpha:1]
                : [UIColor systemGroupedBackgroundColor];
            snap.userInteractionEnabled = NO;
            snap.layer.anchorPoint = CGPointZero;
            snap.bounds = CGRectMake(0, 0, r.size.width, r.size.height);
            snap.layer.position = CGPointZero;
            [clip addSubview:snap];
            [host addSubview:clip];
            _clip = clip;
            _snap = snap;
            _base = CGAffineTransformIdentity;
        }
        [self arm];
    } else if ([kind isEqualToString:@"m"] && t.count >= 5 && pid == _id && _snap) {
        CGFloat k = t[2].doubleValue, cx = t[3].doubleValue, cy = t[4].doubleValue;
        // The point first between the fingers goes where they are now, scaled k about it.
        CGAffineTransform pinch = CGAffineTransformMake(k, 0, 0, k, cx - k * _c0.x, cy - k * _c0.y);
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        _snap.transform = CGAffineTransformConcat(_base, pinch);
        [CATransaction commit];
        [self arm];
    } else if ([kind isEqualToString:@"e"] && pid == _id && _snap) {
        // The page's new frame is committed; it reaches the screen with the next display frame.
        __weak ONPinchOverlay *weakSelf = self;
        void (^removeSoon)(void) = ^{
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.034 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                ONPinchOverlay *me = weakSelf;
                if (me && me->_id == pid) [me remove];
            });
        };
        if (t.count < 5) {
            removeSoon();
            return;
        }
        // Where the page really put the first centre (the scroll range can stop it short of the
        // fingers): the snapshot glides there first, like a scroll view settling after a zoom.
        CGFloat k = t[2].doubleValue, cx = t[3].doubleValue, cy = t[4].doubleValue;
        CGAffineTransform settled = CGAffineTransformConcat(_base, CGAffineTransformMake(k, 0, 0, k, cx - k * _c0.x, cy - k * _c0.y));
        CGAffineTransform now = _snap.transform;
        if (fabs(settled.tx - now.tx) < 0.5 && fabs(settled.ty - now.ty) < 0.5 && fabs(settled.a - now.a) < 0.001 * now.a) {
            removeSoon();
            return;
        }
        [self arm];
        UIView *snap = _snap;
        [UIView animateWithDuration:0.18 delay:0 options:UIViewAnimationOptionCurveEaseOut | UIViewAnimationOptionBeginFromCurrentState
                         animations:^{ snap.transform = settled; }
                         completion:^(BOOL finished) {
                             ONPinchOverlay *me = weakSelf;
                             if (me && me->_id == pid) [me remove];
                         }];
    }
}

@end

#pragma mark - View controller

@interface ONViewController : UIViewController <WKScriptMessageHandlerWithReply, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate, UIPencilInteractionDelegate, UIDocumentPickerDelegate>
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) ONSchemeHandler *schemeHandler;
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) ONInkView *inkView;
@property (nonatomic, strong) ONPinchOverlay *pinchOverlay;
/** The page's "saveFile" waiting for the folder picker (exports, src/platform.ts exportFile). */
@property (nonatomic, copy) void (^saveReply)(id, NSString *);
/** In-flight bridge HTTP requests by the page's request id (main thread only), for httpCancel. */
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSURLSessionTask *> *httpTasks;
@end

@implementation ONViewController

- (void)loadView {
    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    self.schemeHandler = [[ONSchemeHandler alloc] init];
    self.schemeHandler.root = [[[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"public"] stringByStandardizingPath];
    [config setURLSchemeHandler:self.schemeHandler forURLScheme:kScheme];
    config.allowsInlineMediaPlayback = YES;
    config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    config.websiteDataStore = [WKWebsiteDataStore defaultDataStore];

    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *pageRate = [defaults stringForKey:kPageRateKey];
    if (!pageRate) pageRate = [defaults boolForKey:kPage120Key] ? @"max" : @"auto";
    BOOL unlockFailed = [defaults boolForKey:kPageUnlockFailedKey];
    BOOL unlock = [pageRate isEqualToString:@"max"] || ([pageRate isEqualToString:@"auto"] && ONMaxFramesPerSecond() > 60 && !unlockFailed);
    BOOL fullFrameRate = unlock && ONEnableFullFrameRate(config.preferences);

    WKUserContentController *ucc = config.userContentController;
    NSProcessInfo *info = [NSProcessInfo processInfo];
    NSString *bootstrap = [NSString stringWithFormat:@"window.OpenNoteNative = { platform: 'ios', version: '%@', fullFrameRate: %@, pageRate: '%@', unlockFailed: %@, maxFps: %ld, nativePinch: true, lowPower: %@, thermal: %ld };",
                                                     kVersion, fullFrameRate ? @"true" : @"false", pageRate, unlockFailed ? @"true" : @"false", (long)ONMaxFramesPerSecond(),
                                                     info.lowPowerModeEnabled ? @"true" : @"false", (long)info.thermalState];
    [ucc addUserScript:[[WKUserScript alloc] initWithSource:bootstrap injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    [ucc addScriptMessageHandlerWithReply:self contentWorld:[WKContentWorld pageWorld] name:@"opennote"];
    // Native live ink (fire and forget: no reply, so no round trip).
    [ucc addScriptMessageHandler:self contentWorld:[WKContentWorld pageWorld] name:@"opennoteInk"];
    [ucc addScriptMessageHandler:self contentWorld:[WKContentWorld pageWorld] name:@"opennotePinch"];

    self.webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    self.webView.UIDelegate = self;
    self.webView.navigationDelegate = self;
    self.webView.allowsLinkPreview = NO;
    self.webView.allowsBackForwardNavigationGestures = NO;
    self.webView.scrollView.scrollEnabled = NO;
    self.webView.scrollView.bounces = NO;
    self.webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    self.webView.opaque = NO;
    self.webView.backgroundColor = ONLaunchColor();
    // Safari > Develop for debugging (iOS 16.4+). respondsToSelector instead of @available: the
    // Linux toolchain has no compiler-rt for ___isPlatformVersionAtLeast.
    if ([self.webView respondsToSelector:@selector(setInspectable:)]) self.webView.inspectable = YES;
    self.view = self.webView;
    self.inkView = [[ONInkView alloc] initWithFrame:self.webView.bounds];
    [self.webView addSubview:self.inkView];
    self.pinchOverlay = [[ONPinchOverlay alloc] initWithHost:self.webView];

    UIPencilInteraction *pencil = [[UIPencilInteraction alloc] init];
    pencil.delegate = self;
    [self.webView addInteraction:pencil];

    NSURLSessionConfiguration *sc = [NSURLSessionConfiguration defaultSessionConfiguration];
    sc.timeoutIntervalForRequest = 300;
    sc.timeoutIntervalForResource = 900;
    sc.waitsForConnectivity = NO;
    self.session = [NSURLSession sessionWithConfiguration:sc];
    self.httpTasks = [NSMutableDictionary dictionary];
}

- (void)viewDidLoad {
    [super viewDidLoad];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(powerChanged) name:NSProcessInfoPowerStateDidChangeNotification object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(powerChanged) name:NSProcessInfoThermalStateDidChangeNotification object:nil];
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@://%@/index.html", kScheme, kHost]];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (UIStatusBarStyle)preferredStatusBarStyle {
    return UIStatusBarStyleDefault;
}

// Immersive fullscreen: no status bar, the home indicator fades out, and a swipe from a screen
// edge (often the Pencil or the palm while writing) must be repeated before the system acts on it.
- (BOOL)prefersStatusBarHidden {
    return YES;
}

- (BOOL)prefersHomeIndicatorAutoHidden {
    return YES;
}

- (UIRectEdge)preferredScreenEdgesDeferringSystemGestures {
    return UIRectEdgeAll;
}

#pragma mark Bridge

- (void)userContentController:(WKUserContentController *)ucc didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:[NSString class]]) return;
    if ([message.name isEqualToString:@"opennoteInk"]) [self.inkView handleMessage:message.body];
    else if ([message.name isEqualToString:@"opennotePinch"]) [self.pinchOverlay handleMessage:message.body];
}

// Low Power Mode and heat (they make WebKit draw the page at 30 fps), for the crash report.
- (void)powerChanged {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSProcessInfo *info = [NSProcessInfo processInfo];
        NSString *js = [NSString stringWithFormat:@"window.OpenNoteNative&&(OpenNoteNative.lowPower=%@,OpenNoteNative.thermal=%ld)",
                                                  info.lowPowerModeEnabled ? @"true" : @"false", (long)info.thermalState];
        [self.webView evaluateJavaScript:js completionHandler:nil];
    });
}

- (void)userContentController:(WKUserContentController *)ucc
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id _Nullable, NSString *_Nullable))replyHandler {
    NSDictionary *msg = [message.body isKindOfClass:[NSDictionary class]] ? message.body : @{};
    NSString *cmd = msg[@"cmd"];
    if ([cmd isEqualToString:@"http"]) {
        [self handleHttp:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"httpCancel"]) {
        // Closing the connection makes llama-server stop generating (the reply was streamed).
        NSString *rid = [msg[@"id"] description];
        if (rid) [self.httpTasks[rid] cancel];
        replyHandler(@{}, nil);
    } else if ([cmd isEqualToString:@"share"]) {
        [self handleShare:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"saveFile"]) {
        [self handleSaveFile:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"updateDownload"]) {
        [self handleUpdateDownload:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"updateShare"]) {
        [self handleUpdateShare:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"updateCleanup"]) {
        [[NSFileManager defaultManager] removeItemAtPath:ONUpdatesDir() error:nil];
        replyHandler(@{}, nil);
    } else if ([cmd isEqualToString:@"print"]) {
        [self handlePrint:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"pdfPage"]) {
        [self handlePdfPage:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"printPdf"]) {
        [self handlePrintPdf:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"setPageRate"]) {
        NSString *rate = [msg[@"rate"] description];
        if ([@[ @"auto", @"60", @"max" ] containsObject:rate]) {
            [[NSUserDefaults standardUserDefaults] setObject:rate forKey:kPageRateKey];
            // Choosing again also tries the display's rate again.
            [[NSUserDefaults standardUserDefaults] removeObjectForKey:kPageUnlockFailedKey];
        }
        replyHandler(@{}, nil);
    } else if ([cmd isEqualToString:@"setLaunchTheme"]) {
        NSString *hex = [msg[@"background"] description];
        if (hex.length == 7 && [hex hasPrefix:@"#"]) {
            [[NSUserDefaults standardUserDefaults] setObject:hex forKey:kLaunchColorKey];
            UIColor *color = ONLaunchColor();
            self.webView.backgroundColor = color;
            self.view.window.backgroundColor = color;
        }
        replyHandler(@{}, nil);
    } else if ([cmd isEqualToString:@"pageUnlockFailed"]) {
        [[NSUserDefaults standardUserDefaults] setBool:YES forKey:kPageUnlockFailedKey];
        replyHandler(@{}, nil);
    } else if ([cmd isEqualToString:@"haptic"]) {
        NSString *style = msg[@"style"];
        if ([style isEqualToString:@"success"]) {
            [[[UINotificationFeedbackGenerator alloc] init] notificationOccurred:UINotificationFeedbackTypeSuccess];
        } else {
            UIImpactFeedbackGenerator *g = [[UIImpactFeedbackGenerator alloc] initWithStyle:[style isEqualToString:@"light"] ? UIImpactFeedbackStyleLight : UIImpactFeedbackStyleMedium];
            [g impactOccurred];
        }
        replyHandler(@{}, nil);
    } else {
        replyHandler(@{@"error": [NSString stringWithFormat:@"Unknown command %@", cmd]}, nil);
    }
}

- (void)handleHttp:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    NSURL *url = [NSURL URLWithString:msg[@"url"] ?: @""];
    if (!url || !url.scheme) {
        reply(@{@"error": @"Invalid URL"}, nil);
        return;
    }
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    req.HTTPMethod = msg[@"method"] ?: @"GET";
    NSNumber *timeout = msg[@"timeout"];
    req.timeoutInterval = timeout ? timeout.doubleValue : 60;
    NSDictionary *headers = msg[@"headers"];
    if ([headers isKindOfClass:[NSDictionary class]]) {
        [headers enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
            [req setValue:[value description] forHTTPHeaderField:[key description]];
        }];
    }
    id body = msg[@"body"];
    if ([body isKindOfClass:[NSString class]]) req.HTTPBody = [(NSString *)body dataUsingEncoding:NSUTF8StringEncoding];

    NSString *rid = [msg[@"id"] isKindOfClass:[NSString class]] ? msg[@"id"] : nil;
    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (rid) [self.httpTasks removeObjectForKey:rid];
            if (error) {
                reply(@{@"error": error.localizedDescription ?: @"Network error"}, nil);
                return;
            }
            NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
            NSString *text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
            reply(@{@"status": @(status), @"body": text ?: @""}, nil);
        });
    }];
    if (rid) self.httpTasks[rid] = task;
    [task resume];
}

#pragma mark App updates

// App updates from GitHub releases (src/services/updater.ts). iOS lets no app install an app
// package itself: the release's IPA is downloaded in the background into tmp/opennote-update and
// then offered in the share sheet, to open in the installer the user sideloads with (AltStore,
// SideStore, TrollStore, Files...). The folder is deleted when the share sheet closes, and at
// every start (updateCleanup).
static NSString *ONUpdatesDir(void) {
    return [NSTemporaryDirectory() stringByAppendingPathComponent:@"opennote-update"];
}

- (void)handleUpdateDownload:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    NSURL *url = [NSURL URLWithString:msg[@"url"] ?: @""];
    NSString *name = [[msg[@"fileName"] description] lastPathComponent] ?: @"OpenNote.ipa";
    if (!url || ![url.scheme isEqualToString:@"https"]) {
        reply(@{@"error": @"Invalid download URL"}, nil);
        return;
    }
    __weak ONViewController *weakSelf = self;
    __block NSTimer *progressTimer = nil;
    // Its own session: given up after 45 s without data (the shared one waits 5 minutes).
    NSURLSessionConfiguration *sc = [NSURLSessionConfiguration defaultSessionConfiguration];
    sc.timeoutIntervalForRequest = 45;
    sc.timeoutIntervalForResource = 1800;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:sc];
    NSURLSessionDownloadTask *task = [session downloadTaskWithURL:url completionHandler:^(NSURL *location, NSURLResponse *response, NSError *error) {
        NSString *dest = [ONUpdatesDir() stringByAppendingPathComponent:name];
        NSString *failure = nil;
        NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
        if (error) failure = error.localizedDescription ?: @"Download failed";
        else if (status / 100 != 2) failure = [NSString stringWithFormat:@"HTTP %ld", (long)status];
        else {
            NSFileManager *fm = [NSFileManager defaultManager];
            [fm createDirectoryAtPath:ONUpdatesDir() withIntermediateDirectories:YES attributes:nil error:nil];
            [fm removeItemAtPath:dest error:nil];
            NSError *moveError = nil;
            if (![fm moveItemAtURL:location toURL:[NSURL fileURLWithPath:dest] error:&moveError]) failure = moveError.localizedDescription ?: @"Could not save the update";
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            [progressTimer invalidate];
            [session finishTasksAndInvalidate];
            reply(failure ? @{@"error": failure} : @{@"path": dest}, nil);
        });
    }];
    // Progress for the page (window.__opennoteUpdateProgress(received, total)).
    // In the common run-loop modes: a timer in the default mode stops while a finger is on the screen.
    progressTimer = [NSTimer timerWithTimeInterval:0.4 repeats:YES block:^(NSTimer *t) {
        NSString *js = [NSString stringWithFormat:@"window.__opennoteUpdateProgress&&window.__opennoteUpdateProgress(%lld,%lld)",
                                                  task.countOfBytesReceived, task.countOfBytesExpectedToReceive];
        [weakSelf.webView evaluateJavaScript:js completionHandler:nil];
    }];
    [[NSRunLoop mainRunLoop] addTimer:progressTimer forMode:NSRunLoopCommonModes];
    [task resume];
}

- (void)handleUpdateShare:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    NSString *path = [[msg[@"path"] description] stringByStandardizingPath];
    if (!path || ![path hasPrefix:[ONUpdatesDir() stringByStandardizingPath]] || ![[NSFileManager defaultManager] fileExistsAtPath:path]) {
        reply(@{@"error": @"Update file missing"}, nil);
        return;
    }
    UIActivityViewController *avc = [[UIActivityViewController alloc] initWithActivityItems:@[[NSURL fileURLWithPath:path]] applicationActivities:nil];
    avc.popoverPresentationController.sourceView = self.view;
    avc.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(self.view.bounds), 60, 1, 1);
    avc.completionWithItemsHandler = ^(UIActivityType type, BOOL completed, NSArray *items, NSError *error) {
        // The receiving app has its copy (or the user closed the sheet): the download is deleted.
        [[NSFileManager defaultManager] removeItemAtPath:ONUpdatesDir() error:nil];
        reply(completed ? @{@"ok": @YES} : @{@"error": @"cancelled"}, nil);
    };
    [self presentViewController:avc animated:YES completion:nil];
}

- (void)handleShare:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    NSString *name = [msg[@"filename"] lastPathComponent] ?: @"export";
    NSData *data = [[NSData alloc] initWithBase64EncodedString:msg[@"base64"] ?: @"" options:NSDataBase64DecodingIgnoreUnknownCharacters];
    if (!data) {
        reply(@{@"error": @"Invalid file data"}, nil);
        return;
    }
    NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"exports"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    NSURL *fileURL = [NSURL fileURLWithPath:[dir stringByAppendingPathComponent:name]];
    NSError *err = nil;
    if (![data writeToURL:fileURL options:NSDataWritingAtomic error:&err]) {
        reply(@{@"error": err.localizedDescription ?: @"Write failed"}, nil);
        return;
    }
    UIActivityViewController *avc = [[UIActivityViewController alloc] initWithActivityItems:@[fileURL] applicationActivities:nil];
    avc.popoverPresentationController.sourceView = self.view;
    avc.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(self.view.bounds), 60, 1, 1);
    avc.completionWithItemsHandler = ^(UIActivityType type, BOOL completed, NSArray *items, NSError *error) {
        reply(completed ? @{@"ok": @YES} : @{@"error": @"cancelled"}, nil);
    };
    [self presentViewController:avc animated:YES completion:nil];
}

// Exports: Files' folder picker, so the user chooses (and knows) where the file goes; the reply says
// the file's name and folder for the page's confirmation.
- (void)handleSaveFile:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    NSString *name = [msg[@"filename"] lastPathComponent] ?: @"export";
    NSData *data = [[NSData alloc] initWithBase64EncodedString:msg[@"base64"] ?: @"" options:NSDataBase64DecodingIgnoreUnknownCharacters];
    if (!data) {
        reply(@{@"error": @"Invalid file data"}, nil);
        return;
    }
    NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"exports"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    NSURL *fileURL = [NSURL fileURLWithPath:[dir stringByAppendingPathComponent:name]];
    NSError *err = nil;
    if (![data writeToURL:fileURL options:NSDataWritingAtomic error:&err]) {
        reply(@{@"error": err.localizedDescription ?: @"Write failed"}, nil);
        return;
    }
    if (self.saveReply) self.saveReply(@{@"cancelled": @YES}, nil);
    self.saveReply = reply;
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initForExportingURLs:@[ fileURL ] asCopy:YES];
    picker.delegate = self;
    picker.modalPresentationStyle = UIModalPresentationFormSheet;
    [self presentViewController:picker animated:YES completion:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    void (^reply)(id, NSString *) = self.saveReply;
    self.saveReply = nil;
    if (!reply) return;
    NSURL *u = urls.firstObject;
    if (!u) {
        reply(@{@"cancelled": @YES}, nil);
        return;
    }
    reply(@{@"name": u.lastPathComponent ?: @"", @"folder": u.URLByDeletingLastPathComponent.lastPathComponent ?: @""}, nil);
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
    void (^reply)(id, NSString *) = self.saveReply;
    self.saveReply = nil;
    if (reply) reply(@{@"cancelled": @YES}, nil);
}

- (void)handlePrint:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    UIPrintInteractionController *pc = [UIPrintInteractionController sharedPrintController];
    UIPrintInfo *info = [UIPrintInfo printInfo];
    info.outputType = UIPrintInfoOutputGeneral;
    info.jobName = msg[@"name"] ?: @"OpenNote";
    pc.printInfo = info;
    pc.printingItem = nil;
    pc.printFormatter = self.webView.viewPrintFormatter;
    void (^done)(UIPrintInteractionController *, BOOL, NSError *) = ^(UIPrintInteractionController *c, BOOL completed, NSError *error) {
        reply(error ? @{@"error": error.localizedDescription} : @{@"ok": @(completed)}, nil);
    };
    if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad) {
        [pc presentFromRect:CGRectMake(CGRectGetMidX(self.view.bounds), 60, 1, 1) inView:self.view animated:YES completionHandler:done];
    } else {
        [pc presentAnimated:YES completionHandler:done];
    }
}

/**
 * The print layout as a PDF without the print dialog (the PDF export): WebKit's print formatter
 * draws it into a PDF context, as vectors, on pages of exactly widthPx x heightPx (CSS px, 0.75 pt
 * each). The web app shows only the pages to print, all of that size, and measures once how WebKit
 * placed a page on the sheet (src/services/printCalibration.ts): it corrects any scale or offset
 * when joining the pages, and falls back to the print dialog if the pages do not come out as laid
 * out. Replies { base64, pages }.
 */
- (void)handlePdfPage:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    double w = [msg[@"widthPx"] doubleValue], h = [msg[@"heightPx"] doubleValue];
    if (!(w > 0 && h > 0)) {
        reply(@{@"error": @"Page size missing"}, nil);
        return;
    }
    @try {
        CGRect sheet = CGRectMake(0, 0, w * 0.75, h * 0.75);
        UIPrintPageRenderer *renderer = [[UIPrintPageRenderer alloc] init];
        UIViewPrintFormatter *formatter = self.webView.viewPrintFormatter;
        formatter.perPageContentInsets = UIEdgeInsetsZero;
        [renderer addPrintFormatter:formatter startingAtPageAtIndex:0];
        // Read-only properties a renderer normally gets from the print dialog's paper.
        [renderer setValue:[NSValue valueWithCGRect:sheet] forKey:@"paperRect"];
        [renderer setValue:[NSValue valueWithCGRect:sheet] forKey:@"printableRect"];
        NSInteger pages = renderer.numberOfPages;
        NSMutableData *data = [NSMutableData data];
        UIGraphicsBeginPDFContextToData(data, sheet, @{});
        [renderer prepareForDrawingPages:NSMakeRange(0, pages)];
        for (NSInteger i = 0; i < pages; i++) {
            UIGraphicsBeginPDFPageWithInfo(sheet, @{});
            [renderer drawPageAtIndex:i inRect:sheet];
        }
        UIGraphicsEndPDFContext();
        reply(@{@"base64": [data base64EncodedStringWithOptions:0], @"pages": @(pages)}, nil);
    } @catch (NSException *e) {
        reply(@{@"error": [NSString stringWithFormat:@"PDF export unavailable: %@", e.reason ?: e.name]}, nil);
    }
}

/** Prints a PDF the web app made (Print…: the same vector PDF as the export) with the print dialog. */
- (void)handlePrintPdf:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    NSData *pdf = [[NSData alloc] initWithBase64EncodedString:[msg[@"base64"] description] ?: @"" options:0];
    if (!pdf.length || ![UIPrintInteractionController canPrintData:pdf]) {
        reply(@{@"error": @"Nothing to print"}, nil);
        return;
    }
    UIPrintInteractionController *pc = [UIPrintInteractionController sharedPrintController];
    UIPrintInfo *info = [UIPrintInfo printInfo];
    info.outputType = UIPrintInfoOutputGeneral;
    info.jobName = msg[@"name"] ?: @"OpenNote";
    pc.printInfo = info;
    pc.printFormatter = nil;
    pc.printingItem = pdf;
    void (^done)(UIPrintInteractionController *, BOOL, NSError *) = ^(UIPrintInteractionController *c, BOOL completed, NSError *error) {
        c.printingItem = nil;
        reply(error ? @{@"error": error.localizedDescription} : @{@"ok": @(completed)}, nil);
    };
    if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad) {
        [pc presentFromRect:CGRectMake(CGRectGetMidX(self.view.bounds), 60, 1, 1) inView:self.view animated:YES completionHandler:done];
    } else {
        [pc presentAnimated:YES completionHandler:done];
    }
}

#pragma mark Apple Pencil

// WKContentView installs Scribble interactions; with them the system first tries to recognise Pencil
// strokes as handwriting for text inputs, which delays and sometimes swallows strokes on the canvas.
static void ONRemoveScribble(UIView *view) {
    for (id<UIInteraction> interaction in [view.interactions copy]) {
        if ([NSStringFromClass([(NSObject *)interaction class]) containsString:@"Scribble"]) [view removeInteraction:interaction];
    }
    for (UIView *sub in view.subviews) ONRemoveScribble(sub);
}

- (void)viewDidAppear:(BOOL)animated {
    [super viewDidAppear:animated];
    ONRemoveScribble(self.webView);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    ONRemoveScribble(webView);
    [self powerChanged];
}

- (void)pencilInteractionDidTap:(UIPencilInteraction *)interaction {
    [self.webView evaluateJavaScript:@"window.dispatchEvent(new CustomEvent('opennote:pencilDoubleTap'))" completionHandler:nil];
}

#pragma mark WKUIDelegate (JS dialogs, microphone)

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:nil message:message preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) { completionHandler(); }]];
    [self presentViewController:a animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:nil message:message preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:^(UIAlertAction *x) { completionHandler(NO); }]];
    [a addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDestructive handler:^(UIAlertAction *x) { completionHandler(YES); }]];
    [self presentViewController:a animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))completionHandler {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:nil message:prompt preferredStyle:UIAlertControllerStyleAlert];
    [a addTextFieldWithConfigurationHandler:^(UITextField *f) { f.text = defaultText; }];
    [a addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:^(UIAlertAction *x) { completionHandler(nil); }]];
    [a addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) { completionHandler(a.textFields.firstObject.text); }]];
    [self presentViewController:a animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))decisionHandler API_AVAILABLE(ios(15.0)) {
    decisionHandler(type == WKMediaCaptureTypeMicrophone ? WKPermissionDecisionGrant : WKPermissionDecisionPrompt);
}

#pragma mark WKNavigationDelegate

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    // The web content process was killed (memory pressure): reload; notes are persisted in IndexedDB.
    [webView reload];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    if ([url.scheme isEqualToString:kScheme] || [url.scheme isEqualToString:@"about"] || [url.scheme isEqualToString:@"blob"] || [url.scheme isEqualToString:@"data"]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    // External links open in Safari.
    if (action.navigationType == WKNavigationTypeLinkActivated) [[UIApplication sharedApplication] openURL:url options:@{} completionHandler:nil];
    decisionHandler(WKNavigationActionPolicyCancel);
}

@end

#pragma mark - App delegate

@interface ONAppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation ONAppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    ONWindow *window = [[ONWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    window.backgroundColor = ONLaunchColor();
    ONViewController *vc = [[ONViewController alloc] init];
    window.rootViewController = vc;
    window.webView = vc.webView ?: (WKWebView *)vc.view;
    window.booster = [[ONFrameRateBooster alloc] init];
    window.inkView = vc.inkView;
    self.window = window;
    [self.window makeKeyAndVisible];
    return YES;
}

@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass([ONAppDelegate class]));
    }
}
