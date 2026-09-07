const MAILEROO_EMAIL_ENDPOINT = "https://smtp.maileroo.com/api/v2/emails";

export type MailerooAddress = {
  address: string;
  display_name?: string;
};

export type MailerooDelivery = {
  referenceId: string | null;
};

export type SendMailerooOptions = {
  apiKey: string;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  replyToName?: string;
  to: string;
  toName?: string;
  subject: string;
  html: string;
  plainText: string;
  referenceId?: string;
  tags?: Record<string, string>;
  fetcher?: typeof fetch;
};

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class MailerooDeliveryError extends Error {
  constructor(
    message: string,
    public readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = "MailerooDeliveryError";
  }
}

export function validateEmailAddress(
  value: unknown,
  label = "Email address",
): string {
  const address = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(address) || address.length > 254) {
    throw new Error(`${label} is invalid.`);
  }
  return address;
}

function cleanDisplayName(value: unknown, fallback: string): string {
  const name = typeof value === "string"
    ? value.replace(/[\r\n]+/g, " ").trim()
    : "";
  return (name || fallback).slice(0, 100);
}

export async function sendMailerooEmail(
  options: SendMailerooOptions,
): Promise<MailerooDelivery> {
  const apiKey = String(options.apiKey ?? "").trim();
  if (!apiKey) throw new Error("MAILEROO_API_KEY is not configured.");

  const from: MailerooAddress = {
    address: validateEmailAddress(options.fromAddress, "MAILEROO_FROM_EMAIL"),
    display_name: cleanDisplayName(options.fromName, "Pickleball Bookings"),
  };
  const to: MailerooAddress = {
    address: validateEmailAddress(options.to, "Recipient email"),
    ...(options.toName
      ? { display_name: cleanDisplayName(options.toName, "Guest") }
      : {}),
  };
  const replyTo: MailerooAddress = {
    address: validateEmailAddress(options.replyTo, "Tenant Reply-To email"),
    display_name: cleanDisplayName(options.replyToName, options.fromName),
  };
  const referenceId = options.referenceId?.trim().toLowerCase();
  if (referenceId && !/^[a-f0-9]{24}$/.test(referenceId)) {
    throw new Error("Maileroo reference ID is invalid.");
  }

  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(MAILEROO_EMAIL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: replyTo,
        subject: String(options.subject).replace(/[\r\n]+/g, " ").slice(
          0,
          180,
        ),
        html: options.html,
        plain: options.plainText,
        // Booking confirmations are purely transactional. Avoid open pixels
        // and rewritten click-tracking links, which add no product value here
        // and can make a new sending domain look more promotional to filters.
        tracking: false,
        ...(referenceId ? { reference_id: referenceId } : {}),
        ...(options.tags ? { tags: options.tags } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MailerooDeliveryError(
      "Maileroo delivery outcome is unknown after a network failure.",
      true,
    );
  }

  const payload = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!response.ok || payload.success === false) {
    throw new MailerooDeliveryError(
      `Maileroo delivery failed with status ${response.status}.`,
      false,
    );
  }
  const data = payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : {};
  return {
    referenceId: typeof data.reference_id === "string"
      ? data.reference_id
      : null,
  };
}
