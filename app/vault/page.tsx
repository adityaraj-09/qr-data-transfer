import type { Metadata } from "next";
import { AppHeader } from "../app-header";
import { VaultClient } from "./vault-client";

export const metadata: Metadata = {
  title: "Vault · QRFerry",
  description:
    "Encrypt API keys and .env secrets, then stream them as a loss-tolerant QRFerry transfer.",
};

export default function VaultPage() {
  return (
    <>
      <AppHeader active="vault" />
      <VaultClient />
    </>
  );
}
