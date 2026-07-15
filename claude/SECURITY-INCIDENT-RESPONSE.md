# ShippingCloud — Security Incident Response Policy

Adopted: July 15, 2026 · Owner: Spencer Anderson (spencer@freightwire.com)
Applies to: ShippingCloud, ShippingHub by FreightWire, and all connected-store
integrations (Shopify public/custom apps, API integrations).

## 1. What counts as an incident
- Unauthorized access to the database, admin portal, or any customer login.
- Leak or suspected leak of personal data (recipient names, addresses, emails,
  phone numbers, store tokens, account credentials).
- Compromised API secret or carrier credential.
- A vulnerability report from a merchant, researcher, or Shopify.

## 2. Response steps
1. **Contain (immediately):** revoke the affected credential — rotate the API
   secret, disable the compromised login, or invalidate store tokens. Trusted
   devices for an affected account are cleared by disabling and re-enabling
   its second factor.
2. **Assess (within 24 hours):** determine what data was touched, which
   merchants/stores are affected, and the time window, using function logs and
   the audit trail.
3. **Notify (within 72 hours of confirmation):** email affected merchants at
   their account address from spencer@freightwire.com with what happened, what
   data was involved, and what we did. If Shopify store data is involved,
   notify Shopify partner support as required by the Partner agreement.
4. **Remediate:** fix the root cause before restoring normal operation;
   snapshot the database before any corrective writes.
5. **Record:** log the incident, timeline, and fix in this repo so the history
   is auditable.

## 3. Preventive posture (standing)
- TLS on all connections; database encrypted at rest (SOC 2–audited provider);
  managed encrypted backups.
- Admin and staff logins use strong unique passwords with 2FA
  (authenticator or email code) enabled.
- Personal data access is scoped per account; server function logs record
  access; test/staging uses a separate database from production.
- Additive-only database writes with pre-write snapshots; deletions require
  explicit confirmation.

## 4. Merchant-initiated requests
Data export, deletion, and redaction requests (including Shopify
customers/redact, shop/redact, customers/data_request webhooks) are honored
per the privacy policy at https://shippingcloud.net/privacy.html.
