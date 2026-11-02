// Wallet connection through NEAR Connect, the connector the NEAR docs use for wallet login.
import { NearConnector } from "@hot-labs/near-connect";

const connector = new NearConnector({ network: "testnet" });
let wallet = null;

export const TGAS = 10n ** 12n;
export const functionCall = (methodName, args, { gas = 100n, deposit = 0n } = {}) => ({
  type: "FunctionCall",
  params: { methodName, args, gas: String(gas * TGAS), deposit: String(deposit) },
});

/** Calls `onChange` with the account ID, or null when signed out. */
export function watchWallet(onChange) {
  connector.on("wallet:signIn", (event) => {
    wallet = event.wallet;
    onChange(event.accounts[0]?.accountId ?? null);
  });
  connector.on("wallet:signOut", () => {
    wallet = null;
    onChange(null);
  });
  connector.getConnectedWallet().then((connected) => {
    wallet = connected.wallet;
    onChange(connected.accounts[0]?.accountId ?? null);
  }).catch(() => {}); // Nothing connected yet.
}

export async function connectWallet() {
  wallet = await connector.connect();
  const [account] = await wallet.getAccounts();
  return account?.accountId ?? null;
}

export async function disconnectWallet() {
  await connector.disconnect(wallet);
  wallet = null;
}

/** Signs and sends. Returns the transaction hash. */
export async function sendTransaction(signerId, receiverId, actions) {
  if (!wallet) throw new Error("Connect a wallet first.");
  const result = await wallet.signAndSendTransaction({ network: "testnet", signerId, receiverId, actions });
  return result.transaction?.hash ?? result.transaction_outcome?.id;
}
