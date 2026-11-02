const fs = require("node:fs");
const path = require("node:path");
const { SignedDataVerifier, Environment } = require("@apple/app-store-server-library");

const BUNDLE_ID = "sg.com.missingems.SGBusTime";
const APP_APPLE_ID = 1487419506;
const PRO_PRODUCT_ID = "sg.com.missingems.SGBusTime.pro.monthly";
const MAX_LENGTH = 16_384;

let verifiers;

function makeVerifiers() {
  const roots = [fs.readFileSync(path.join(__dirname, "..", "certs", "AppleRootCA-G3.cer"))];
  return [
    new SignedDataVerifier(roots, true, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID),
    new SignedDataVerifier(roots, true, Environment.SANDBOX, BUNDLE_ID),
  ];
}

function entitled(transaction, now = Date.now()) {
  return transaction?.bundleId === BUNDLE_ID
    && transaction.productId === PRO_PRODUCT_ID
    && transaction.revocationDate == null
    && (transaction.expiresDate == null || transaction.expiresDate > now);
}

async function hasPro(signedTransaction, now = Date.now()) {
  if (typeof signedTransaction !== "string" || signedTransaction.length > MAX_LENGTH) return false;
  verifiers ??= makeVerifiers();
  for (const verifier of verifiers) {
    try {
      return entitled(await verifier.verifyAndDecodeTransaction(signedTransaction), now);
    } catch {
      continue;
    }
  }
  return false;
}

module.exports = { hasPro, entitled, PRO_PRODUCT_ID };
