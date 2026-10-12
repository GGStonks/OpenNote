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
//      haptic UIImpactFeedbackGenerator tick (smart-pen snapping).
//  - Apple Pencil double-tap is forwarded as the DOM event "opennote:pencilDoubleTap".
//  - iPadOS Scribble is removed from the web view: it holds back Pencil strokes while deciding
//    whether they are handwriting for a text field, which dropped/delayed ink on the canvas.
//  - JS alert/confirm/prompt panels and microphone permission (audio notes) are implemented.

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

static NSString *const kScheme = @"opennote";
static NSString *const kHost = @"app";
static NSString *const kVersion = @"1.2.0";

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

#pragma mark - View controller

@interface ONViewController : UIViewController <WKScriptMessageHandlerWithReply, WKUIDelegate, WKNavigationDelegate, UIPencilInteractionDelegate>
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) ONSchemeHandler *schemeHandler;
@property (nonatomic, strong) NSURLSession *session;
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

    WKUserContentController *ucc = config.userContentController;
    NSString *bootstrap = [NSString stringWithFormat:@"window.OpenNoteNative = { platform: 'ios', version: '%@' };", kVersion];
    [ucc addUserScript:[[WKUserScript alloc] initWithSource:bootstrap injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    [ucc addScriptMessageHandlerWithReply:self contentWorld:[WKContentWorld pageWorld] name:@"opennote"];

    self.webView = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
    self.webView.UIDelegate = self;
    self.webView.navigationDelegate = self;
    self.webView.allowsLinkPreview = NO;
    self.webView.allowsBackForwardNavigationGestures = NO;
    self.webView.scrollView.scrollEnabled = NO;
    self.webView.scrollView.bounces = NO;
    self.webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    self.webView.opaque = NO;
    self.webView.backgroundColor = [UIColor systemGroupedBackgroundColor];
    // Safari > Develop for debugging (iOS 16.4+). respondsToSelector instead of @available: the
    // Linux toolchain has no compiler-rt for ___isPlatformVersionAtLeast.
    if ([self.webView respondsToSelector:@selector(setInspectable:)]) self.webView.inspectable = YES;
    self.view = self.webView;

    UIPencilInteraction *pencil = [[UIPencilInteraction alloc] init];
    pencil.delegate = self;
    [self.webView addInteraction:pencil];

    NSURLSessionConfiguration *sc = [NSURLSessionConfiguration defaultSessionConfiguration];
    sc.timeoutIntervalForRequest = 300;
    sc.timeoutIntervalForResource = 900;
    sc.waitsForConnectivity = NO;
    self.session = [NSURLSession sessionWithConfiguration:sc];
}

- (void)viewDidLoad {
    [super viewDidLoad];
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@://%@/index.html", kScheme, kHost]];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (UIStatusBarStyle)preferredStatusBarStyle {
    return UIStatusBarStyleDefault;
}

#pragma mark Bridge

- (void)userContentController:(WKUserContentController *)ucc
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id _Nullable, NSString *_Nullable))replyHandler {
    NSDictionary *msg = [message.body isKindOfClass:[NSDictionary class]] ? message.body : @{};
    NSString *cmd = msg[@"cmd"];
    if ([cmd isEqualToString:@"http"]) {
        [self handleHttp:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"share"]) {
        [self handleShare:msg reply:replyHandler];
    } else if ([cmd isEqualToString:@"print"]) {
        [self handlePrint:msg reply:replyHandler];
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

    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (error) {
                reply(@{@"error": error.localizedDescription ?: @"Network error"}, nil);
                return;
            }
            NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
            NSString *text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
            reply(@{@"status": @(status), @"body": text ?: @""}, nil);
        });
    }];
    [task resume];
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

- (void)handlePrint:(NSDictionary *)msg reply:(void (^)(id, NSString *))reply {
    UIPrintInteractionController *pc = [UIPrintInteractionController sharedPrintController];
    UIPrintInfo *info = [UIPrintInfo printInfo];
    info.outputType = UIPrintInfoOutputGeneral;
    info.jobName = msg[@"name"] ?: @"OpenNote";
    pc.printInfo = info;
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
    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    self.window.backgroundColor = [UIColor systemGroupedBackgroundColor];
    self.window.rootViewController = [[ONViewController alloc] init];
    [self.window makeKeyAndVisible];
    return YES;
}

@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass([ONAppDelegate class]));
    }
}
