const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { SignedDataVerifier, Environment } = require("@apple/app-store-server-library");

const BUNDLE_ID = "sg.com.missingems.SGBusTime";
const APP_APPLE_ID = 1487419506;
const PRO_PRODUCT_IDS = new Set([
  "sg.com.missingems.SGBusTime.pro.monthly",
  "sg.com.missingems.SGBusTime.pro.yearly",
]);
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
    && PRO_PRODUCT_IDS.has(transaction.productId)
    && transaction.revocationDate == null
    && (transaction.expiresDate == null || transaction.expiresDate > now);
}

function owner(transaction) {
  const original = transaction?.originalTransactionId;
  if (original == null || original === "") return null;
  return crypto.createHash("sha256").update(String(original)).digest("hex").slice(0, 32);
}

async function proOwner(signedTransaction, now = Date.now()) {
  if (typeof signedTransaction !== "string" || signedTransaction.length > MAX_LENGTH) return null;
  verifiers ??= makeVerifiers();
  for (const verifier of verifiers) {
    try {
      const transaction = await verifier.verifyAndDecodeTransaction(signedTransaction);
      return entitled(transaction, now) ? owner(transaction) : null;
    } catch {
      continue;
    }
  }
  return null;
}

module.exports = { proOwner, owner, entitled, PRO_PRODUCT_IDS };
