/** Attribution any app that shows Open Camping DB data must display. */
export const ATTRIBUTION = "© OpenStreetMap contributors, Open Camping DB";

/** Short heading for the consent prompt. */
export const CONSENT_TITLE = "Share with Open Camping DB";

/**
 * Wording an app should show, with an agree button, before the first report,
 * review or check is sent. Pass `consent: true` only after the user agrees.
 */
export const CONSENT_TEXT =
  "What you send becomes part of Open Camping DB, a free and open list of places to camp and stop in Australia. " +
  "Anyone may use, share and adapt it: the database under the Open Database Licence (ODbL 1.0) and its contents " +
  "under the Database Contents Licence (DbCL 1.0). Please don't include names, email addresses or phone numbers. " +
  "We never publish who sent it. Changes we accept may also be passed to OpenStreetMap as notes for its volunteer " +
  "mappers to check.";

/**
 * Wording an app should show, with an agree button, before a traveller's
 * first photo is sent, beside CONSENT_TEXT. Pass `consent: true` to `photo`
 * only after the user agrees to both. Not final: the wording may change
 * before photos launch.
 */
export const PHOTO_CONSENT_TEXT =
  "You took this photo yourself. It shows the place: people's faces and number plates are not its subject, and anyone " +
  "you can recognise in it has agreed to it being shared. You keep the copyright and license it to everyone under " +
  "Creative Commons Attribution 4.0 (CC BY 4.0), so anyone may use and share it with credit to Open Camping DB " +
  "travellers. We never publish who sent it, and you can remove all your photos by deleting your account.";

/** Link to the licence details, for a "Learn more" button. */
export const CONSENT_LEARN_MORE_URL = "https://github.com/opencampingdb/data#licence";

/** Where the full owner terms are published. */
export const OWNER_TERMS_URL = "https://opencampingdb.github.io/owners/terms.html";

/**
 * Short summary of the owner terms, to show next to the tick box on any form
 * that sends an owner claim, listing or update. Link to OWNER_TERMS_URL for
 * the full text.
 */
export const OWNER_TERMS_SUMMARY =
  "You run this place, or are allowed to act for whoever does, and it holds any council or other approvals it needs. " +
  "What you send about the place (its facts, description, booking details and dates) is published in Open Camping DB " +
  "under the Open Database Licence (ODbL 1.0), so anyone may use and share it. Your name and email stay private: we use " +
  "them only to check your claim and contact you about this place. Facts we accept from you may also be passed to " +
  "OpenStreetMap as notes for its volunteer mappers to check.";
