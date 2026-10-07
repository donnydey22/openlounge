import UIKit
import WebKit

/// Full-screen WKWebView wrapper around the production Open Lounge web app — the iOS
/// equivalent of android/.../MainActivity.java.
final class WebViewController: UIViewController {
    /// Production server. Overridable at build time via the OPENLOUNGE_START_URL build setting
    /// (written into Info.plist as OpenLoungeStartURL).
    static let startURL: URL = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "OpenLoungeStartURL") as? String,
           let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           url.scheme == "https", url.host != nil {
            return url
        }
        return URL(string: "https://openlounge-production.up.railway.app")!
    }()

    private var webView: WKWebView!
    private let spinner = UIActivityIndicatorView(style: .large)
    private let errorView = UIStackView()
    private let errorLabel = UILabel()
    private var hasLoadedOnce = false

    private static let background = UIColor(red: 0x1C / 255, green: 0x1C / 255, blue: 0x1E / 255, alpha: 1)

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background
        setUpWebView()
        setUpSpinner()
        setUpErrorView()
        AudioSession.shared.requestMicrophonePermissionIfNeeded()
        loadStartPage()
    }

    // MARK: - Setup

    private func setUpWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.websiteDataStore = .default() // persistent cookies / localStorage (login survives restarts)
        config.applicationNameForUserAgent = "Mobile/15E148 OpenLoungeiOS/\(Self.appVersion)"
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        // The web app uses viewport-fit=cover + env(safe-area-inset-*), so let it draw edge to edge.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            // Lets Donny debug ad-hoc builds with Safari > Develop on a Mac.
            webView.isInspectable = true
        }

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        self.webView = webView
    }

    private func setUpSpinner() {
        spinner.color = UIColor(red: 0xF2 / 255, green: 0xB3 / 255, blue: 0x66 / 255, alpha: 1)
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func setUpErrorView() {
        errorLabel.textColor = .white
        errorLabel.numberOfLines = 0
        errorLabel.textAlignment = .center
        errorLabel.font = .preferredFont(forTextStyle: .body)

        let retry = UIButton(type: .system)
        retry.setTitle("Retry", for: .normal)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.tintColor = spinner.color
        retry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

        errorView.axis = .vertical
        errorView.spacing = 16
        errorView.alignment = .center
        errorView.addArrangedSubview(errorLabel)
        errorView.addArrangedSubview(retry)
        errorView.isHidden = true
        errorView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(errorView)
        NSLayoutConstraint.activate([
            errorView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorView.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor, constant: 16),
            errorView.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor, constant: -16),
        ])
    }

    // MARK: - Loading

    /// Mirrors the Android wrapper's clearCache(true) + LOAD_NO_CACHE: drop the HTTP cache
    /// (keeping cookies/localStorage) and fetch the HTML fresh so new Railway deploys show up.
    private func loadStartPage() {
        showLoading()
        let cacheTypes: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
        WKWebsiteDataStore.default().removeData(ofTypes: cacheTypes, modifiedSince: .distantPast) { [weak self] in
            guard let self else { return }
            let request = URLRequest(
                url: Self.startURL,
                cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
                timeoutInterval: 30
            )
            self.webView.load(request)
        }
    }

    @objc private func retryTapped() {
        if hasLoadedOnce, webView.url != nil {
            showLoading()
            webView.reloadFromOrigin()
        } else {
            loadStartPage()
        }
    }

    private func showLoading() {
        errorView.isHidden = true
        webView.isHidden = false
        if !hasLoadedOnce { spinner.startAnimating() }
    }

    private func showWeb() {
        hasLoadedOnce = true
        spinner.stopAnimating()
        errorView.isHidden = true
        webView.isHidden = false
    }

    private func showError(_ error: Error) {
        let nsError = error as NSError
        // Cancelled navigations (e.g. a new load superseding an old one) aren't real failures.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return } // frame load interrupted
        spinner.stopAnimating()
        webView.isHidden = true
        errorLabel.text = "Could not load Open Lounge.\n\n\(error.localizedDescription)\n\nCheck your internet connection and try again."
        errorView.isHidden = false
    }

    private static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    private func isAppOrigin(host: String?, scheme: String?) -> Bool {
        scheme?.lowercased() == "https" && host?.lowercased() == Self.startURL.host?.lowercased()
    }
}

// MARK: - WKNavigationDelegate

extension WebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        showWeb()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // WebKit's content process can be killed under memory pressure; recover instead of a blank screen.
        webView.reload()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }
        if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        // mailto:, tel:, sms:, itms-apps:, etc. → hand off to iOS (same as Android's ACTION_VIEW).
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        decisionHandler(.cancel)
    }
}

// MARK: - WKUIDelegate

extension WebViewController: WKUIDelegate {
    /// Grant getUserMedia({audio}) for the Open Lounge origin without WebKit's extra per-site
    /// prompt (the OS-level NSMicrophoneUsageDescription prompt still applies once).
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        if isAppOrigin(host: origin.host, scheme: origin.protocol), type == .microphone {
            decisionHandler(.grant)
        } else {
            decisionHandler(.prompt)
        }
    }

    /// target="_blank" / window.open: same-origin links stay in the app, external ones open in Safari.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isAppOrigin(host: url.host, scheme: url.scheme) {
                webView.load(navigationAction.request)
            } else {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presentOrFallback(alert) { completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presentOrFallback(alert) { completionHandler(false) }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text)
        })
        presentOrFallback(alert) { completionHandler(nil) }
    }

    private func presentOrFallback(_ alert: UIAlertController, fallback: () -> Void) {
        guard view.window != nil, presentedViewController == nil else {
            fallback()
            return
        }
        present(alert, animated: true)
    }
}
