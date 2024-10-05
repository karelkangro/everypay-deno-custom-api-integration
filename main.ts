import { Application, Router } from "https://deno.land/x/oak@v17.0.0/mod.ts";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import { encodeBase64 } from "@std/encoding";
import { crypto } from "@std/crypto";

const env = config();
const app = new Application();
const router = new Router();

const EVERYPAY_API_URL = env.EVERYPAY_API_URL;
const EVERYPAY_USERNAME = env.EVERYPAY_USERNAME;
const EVERYPAY_SECRET = env.EVERYPAY_SECRET;
const EVERYPAY_ACCOUNT = env.EVERYPAY_ACCOUNT;
const BACKEND_APP_URL = env.BACKEND_APP_URL;
const FRONTEND_APP_URL = env.FRONTEND_APP_URL;

const getAuthHeader = () =>
  `Basic ${encodeBase64(`${EVERYPAY_USERNAME}:${EVERYPAY_SECRET}`)}`;

const generateNonce = () => crypto.randomUUID();

router.post("/initiate-payment", async (ctx) => {
  console.log('initiate-payment');

  const { amount, order_reference, email } = await ctx.request.body.json();

  try {
    const response = await fetch(`${EVERYPAY_API_URL}/v4/payments/oneoff`, {
      method: "POST",
      headers: {
        "Authorization": getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_name: EVERYPAY_ACCOUNT,
        amount,
        order_reference,
        nonce: generateNonce(),
        timestamp: new Date().toISOString(),
        customer_url: `${BACKEND_APP_URL}/payment-callback`,
        email,
        customer_ip: ctx.request.ip,
        api_username: EVERYPAY_USERNAME,
      }),
    });

    const paymentData = await response.json();

    if (!response.ok) {
      throw new Error(paymentData.error?.message || "Payment initiation failed");
    }

    ctx.response.body = {
      payment_link: paymentData.payment_link,
      payment_reference: paymentData.payment_reference
    };
  } catch (error) {
    console.error("Payment initiation error:", error);
    ctx.response.status = 400;
    ctx.response.body = {
      error: "Payment initiation failed",
      details: error.message
    };
  }
});

router.get("/payment-callback", async (ctx) => {
  const payment_reference = ctx.request.url.searchParams.get("payment_reference");
  const order_reference = ctx.request.url.searchParams.get("order_reference");

  try {
    // NB! api_username is needed but is undocumented in https://support.every-pay.com/api-documentation
    const apiUrl = `${EVERYPAY_API_URL}/v4/payments/${payment_reference}?api_username=${EVERYPAY_USERNAME}`
    const response = await fetch(
      apiUrl,
      {
        method: "GET",
        headers: {
          "Authorization": getAuthHeader(),
          "Content-Type": "application/json",
        }
      });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Payment API error response:", errorData);
      throw new Error(`HTTP error! status: ${response.status}, message: ${JSON.stringify(errorData)}`);
    }

    const paymentData = await response.json();
    const redirectUrl = new URL(`${BACKEND_APP_URL}/payment-result`);
    redirectUrl.searchParams.set("status", paymentData.payment_state);
    redirectUrl.searchParams.set("reference", payment_reference ?? "");
    redirectUrl.searchParams.set("order", order_reference ?? "");

    ctx.response.redirect(redirectUrl.toString());
  } catch (error) {
    console.error("Error processing payment callback:", error);
    const errorUrl = new URL(`${BACKEND_APP_URL}/payment-result`);
    errorUrl.searchParams.set("status", "error");
    errorUrl.searchParams.set("message", error.message);
    errorUrl.searchParams.set("order", order_reference ?? "");
    ctx.response.redirect(errorUrl.toString());
  }
});

router.get("/payment-result", (ctx) => {
  const status = ctx.request.url.searchParams.get("status");
  const reference = ctx.request.url.searchParams.get("reference");
  const message = ctx.request.url.searchParams.get("message");
  ctx.response.body = { paymentStatus: status, paymentReference: reference, errorMessage: message };
});

router.post("/webhook", async (ctx) => {
  const signature = ctx.request.headers.get("everypay-signature");
  const body = await ctx.request.body.json();

  const computedSignature = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body + env.EVERYPAY_SHARED_KEY)
  ).then(hash => Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join(""));

  if (computedSignature !== signature) {
    ctx.response.status = 400;
    ctx.response.body = "Invalid signature";
    return;
  }

  const event = JSON.parse(body);

  if (event.event_name === "status_updated") {
    // TODO
    return 1
  }

  ctx.response.status = 200;
});

app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", FRONTEND_APP_URL);
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 200;
    return;
  }
  await next();
});

app.use(router.routes());
app.use(router.allowedMethods());

const PORT = parseInt(env.PORT || "3000");
console.log('app runs PORT:', env.PORT);
await app.listen({ port: PORT });