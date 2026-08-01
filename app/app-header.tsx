import Link from "next/link";

export function AppHeader({ active }: { active: "send" | "scan" | "vault" }) {
  return (
    <header className="site-header">
      <Link className="wordmark" href="/" aria-label="QRFerry home">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>QRFerry</span>
      </Link>
      <nav className="mode-switch" aria-label="Transfer mode">
        <Link className={active === "send" ? "active" : ""} href="/">
          Send
        </Link>
        <Link className={active === "vault" ? "active" : ""} href="/vault">
          Vault
        </Link>
        <Link className={active === "scan" ? "active" : ""} href="/scan">
          Scan
        </Link>
      </nav>
      <span className="local-badge">
        <span aria-hidden="true" />
        Device to device
      </span>
    </header>
  );
}
