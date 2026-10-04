import { sendMailerooEmail as sendEmail, type SendMailerooOptions } from './maileroo.ts';
export { MailerooDeliveryError } from './maileroo.ts';

// Venue owner confirmed by the system owner. Keep the existing support inbox too.
export const PICKLESTREET_OWNER_REPLY_EMAIL = 'daap.perspectives@gmail.com';
export function sendMailerooEmail(options: SendMailerooOptions) {
  const configured = Array.isArray(options.replyTo) ? options.replyTo : [options.replyTo];
  return sendEmail({...options, replyTo: [PICKLESTREET_OWNER_REPLY_EMAIL, ...configured]});
}
