"use client";
// Paid sticker checkout on the WEB: PayPal button + Apple Pay + Google Pay, all through PayPal (one processor, one
// webhook / entitlement path). Each button appears only when that browser is eligible:
//  - PayPal: PayPal JS SDK Buttons (fundingSource PAYPAL) — any modern browser
//  - Apple Pay: window.ApplePaySession && canMakePayments() && paypal.Applepay().config().isEligible (Safari / Apple devices)
//  - Google Pay: paypal.Googlepay().config() + google PaymentsClient.isReadyToPay() (Chrome, Android, …; TEST env in sandbox)
// Orders are created and captured server-side (Orders v2). Never rendered inside the phone wrappers.
import { useEffect, useRef, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { api, applyMine, useStickers } from "@/lib/stickers/client";
import { formatPrice, type MyStickers, type Receipt, type StickerPack } from "@/lib/stickers/types";

const BRAND = "Open Lounge";

/* eslint-disable @typescript-eslint/no-explicit-any */
type PayPalNS = any;
declare global {
  interface Window {
    paypal?: PayPalNS;
    google?: any;
    ApplePaySession?: any;
  }
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string, attrs: Record<string, string> = {}) {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
      s.onload = () => resolve();
      s.onerror = () => {
        scripts.delete(src);
        reject(new Error(`failed to load ${src}`));
      };
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

async function createOrder(packId: string, funding: string) {
  const r = await api<{ orderId: string }>("/checkout/create", { body: { packId, funding } });
  return r.orderId;
}
async function captureOrder(orderId: string) {
  return api<{ receipt: Receipt; mine: MyStickers; pending?: boolean }>("/checkout/capture", { body: { orderId } });
}

export function PayButtons({ pack, onPaid }: { pack: StickerPack; onPaid: (r: Receipt) => void }) {
  const config = useStickers((s) => s.config);
  const ppRef = useRef<HTMLDivElement>(null);
  const gpRef = useRef<HTMLDivElement>(null);
  const [sdk, setSdk] = useState<"loading" | "ready" | "failed">("loading");
  const [apple, setApple] = useState<any>(null); // Applepay config when eligible
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = (pack.priceCents! / 100).toFixed(2);

  const finish = (r: { receipt: Receipt; mine: MyStickers; pending?: boolean }) => {
    applyMine(r.mine);
    if (r.pending) setError("Payment is processing. Your stickers unlock as soon as PayPal confirms.");
    else onPaid(r.receipt);
  };

  useEffect(() => {
    if (!config?.paidEnabled || !config.paypalClientId) return;
    let cancelled = false;
    const components = ["buttons", config.applePay && "applepay", config.googlePay && "googlepay"].filter(Boolean).join(",");
    const qs = new URLSearchParams({ "client-id": config.paypalClientId, currency: config.currency, intent: "capture", components, "disable-funding": "paylater,venmo,card" });
    loadScript(`https://www.paypal.com/sdk/js?${qs}`, { "data-namespace": "paypal" })
      .then(async () => {
        if (cancelled || !window.paypal) return;
        setSdk("ready");
        // PayPal button
        const btn = window.paypal.Buttons({
          fundingSource: window.paypal.FUNDING.PAYPAL,
          style: { layout: "horizontal", color: "gold", shape: "pill", label: "pay", height: 46, tagline: false },
          createOrder: () => createOrder(pack.id, "paypal"),
          onApprove: async (data: { orderID: string }) => {
            setBusy(true);
            try {
              finish(await captureOrder(data.orderID));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          },
          onError: () => setError("PayPal couldn't complete the payment. You weren't charged."),
        });
        if (btn.isEligible() && ppRef.current) {
          ppRef.current.innerHTML = "";
          await btn.render(ppRef.current);
        }
        // Apple Pay (Safari on Apple devices with a card in Wallet)
        if (config.applePay && window.ApplePaySession && window.paypal.Applepay) {
          try {
            if (window.ApplePaySession.canMakePayments()) {
              const cfg = await window.paypal.Applepay().config();
              if (!cancelled && cfg?.isEligible) setApple(cfg);
            }
          } catch {
            /* not eligible */
          }
        }
        // Google Pay
        if (config.googlePay && window.paypal.Googlepay) {
          try {
            await loadScript("https://pay.google.com/gp/p/js/pay.js");
            const gp = window.paypal.Googlepay();
            const gcfg = await gp.config();
            const client = new window.google.payments.api.PaymentsClient({
              environment: config.mode === "live" ? "PRODUCTION" : "TEST",
              paymentDataCallbacks: {
                onPaymentAuthorized: async (paymentData: any) => {
                  try {
                    const orderId = await createOrder(pack.id, "google_pay");
                    let { status } = await gp.confirmOrder({ orderId, paymentMethodData: paymentData.paymentMethodData });
                    if (status === "PAYER_ACTION_REQUIRED") {
                      await gp.initiatePayerAction({ orderId });
                      status = "APPROVED";
                    }
                    if (status !== "APPROVED") return { transactionState: "ERROR", error: { intent: "PAYMENT_AUTHORIZATION", message: "Payment wasn't approved" } };
                    finish(await captureOrder(orderId));
                    return { transactionState: "SUCCESS" };
                  } catch (e) {
                    return { transactionState: "ERROR", error: { intent: "PAYMENT_AUTHORIZATION", message: (e as Error).message } };
                  }
                },
              },
            });
            const ready = await client.isReadyToPay({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: gcfg.allowedPaymentMethods });
            if (!cancelled && ready?.result && gpRef.current) {
              const button = client.createButton({
                buttonType: "buy",
                buttonRadius: 999,
                buttonSizeMode: "fill",
                allowedPaymentMethods: gcfg.allowedPaymentMethods,
                onClick: () =>
                  client
                    .loadPaymentData({
                      apiVersion: 2,
                      apiVersionMinor: 0,
                      allowedPaymentMethods: gcfg.allowedPaymentMethods,
                      transactionInfo: { currencyCode: pack.currency, totalPriceStatus: "FINAL", totalPrice: amount, totalPriceLabel: "Total" },
                      merchantInfo: { ...gcfg.merchantInfo, ...(config.googleMerchantId ? { merchantId: config.googleMerchantId } : {}), merchantName: BRAND },
                      callbackIntents: ["PAYMENT_AUTHORIZATION"],
                    })
                    .catch(() => {}),
              });
              gpRef.current.innerHTML = "";
              gpRef.current.appendChild(button);
            }
          } catch {
            /* Google Pay not available in this browser */
          }
        }
      })
      .catch(() => !cancelled && setSdk("failed"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.paidEnabled, config?.paypalClientId, pack.id]);

  const payWithApple = () => {
    // must run synchronously inside the click (Apple requires a user gesture to create + begin the session)
    const ap = window.paypal.Applepay();
    const session = new window.ApplePaySession(4, {
      countryCode: apple.countryCode,
      merchantCapabilities: apple.merchantCapabilities,
      supportedNetworks: apple.supportedNetworks,
      currencyCode: pack.currency,
      requiredBillingContactFields: ["postalAddress"],
      total: { label: BRAND, type: "final", amount },
      lineItems: [{ label: `Open Lounge sticker pack: ${pack.title}`, amount, type: "final" }],
    });
    session.onvalidatemerchant = (event: any) =>
      ap
        .validateMerchant({ validationUrl: event.validationURL, displayName: BRAND })
        .then((r: any) => session.completeMerchantValidation(r.merchantSession))
        .catch(() => session.abort());
    session.onpaymentauthorized = async (event: any) => {
      try {
        const orderId = await createOrder(pack.id, "apple_pay");
        await ap.confirmOrder({ orderId, token: event.payment.token, billingContact: event.payment.billingContact });
        session.completePayment(window.ApplePaySession.STATUS_SUCCESS);
        finish(await captureOrder(orderId));
      } catch (e) {
        session.completePayment(window.ApplePaySession.STATUS_FAILURE);
        setError((e as Error).message);
      }
    };
    session.begin();
  };

  return (
    <div className="space-y-2.5" data-testid="pay-buttons">
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-400">Open Lounge sticker pack: <span className="text-zinc-200">{pack.title}</span></span>
        <span className="font-semibold text-zinc-100">{formatPrice(pack.priceCents!, pack.currency)}</span>
      </div>
      {apple && (
        <button
          type="button"
          onClick={payWithApple}
          aria-label="Buy with Apple Pay"
          data-testid="applepay-btn"
          className="block h-[46px] w-full overflow-hidden rounded-full"
          style={{ WebkitAppearance: "-apple-pay-button", ["-apple-pay-button-type" as string]: "buy", ["-apple-pay-button-style" as string]: "white" } as React.CSSProperties}
        />
      )}
      <div ref={gpRef} className="h-[46px] empty:hidden" data-testid="googlepay-slot" />
      <div ref={ppRef} className="min-h-[46px] [color-scheme:light]" data-testid="paypal-slot" />
      {sdk === "loading" && (
        <div className="flex h-[46px] items-center justify-center text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {sdk === "failed" && <p className="text-center text-sm text-red-400">Checkout couldn&apos;t load. Check your connection and try again.</p>}
      {busy && <p className="text-center text-sm text-zinc-400">Finishing up…</p>}
      {error && <p className="text-center text-sm text-amber-300">{error}</p>}
      <p className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-500">
        <Lock className="h-3 w-3" /> Paid securely to Open Lounge through PayPal{config?.mode === "sandbox" ? " (sandbox test mode)" : ""}
      </p>
    </div>
  );
}
