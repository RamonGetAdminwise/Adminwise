/**
 * Every text of the daily brief, in English. A second language is a copy of
 * this file with the same keys, registered in index.ts: a translation job, not
 * a rewrite. Keep sentences whole (no gluing of fragments in code), so they can
 * be translated naturally.
 */
export const en = {
  languageNames: {
    en: "English", pl: "Polish", de: "German", cs: "Czech", nl: "Dutch", fr: "French", es: "Spanish", it: "Italian",
    sk: "Slovak", uk: "Ukrainian", hu: "Hungarian", ro: "Romanian",
  } as Record<string, string>,

  documentTypes: { invoice: "invoice", order: "order", contract: "contract", offer: "offer", other: "other document" } as Record<string, string>,

  subject: (localDate: string) => `Your daily brief - ${localDate}`,
  greeting: "Good morning,",
  nothingHappened: (appName: string) => `Nothing needed your attention yesterday. ${appName} is running.`,

  needsYou: {
    heading: (count: number) => `NEEDS YOU TODAY (${count})`,
    replyInOutlook: (subject: string, senderDomain: string) =>
      `- Reply draft for "${subject}" (from ${senderDomain}) - in your Outlook Drafts`,
    replyByEmail: (subject: string, senderDomain: string) =>
      `- Reply draft for "${subject}" (from ${senderDomain}) - emailed to you`,
    unlistedLanguage: (language: string) =>
      ` [written in ${language}, a language not on your list: please check it]`,
  },

  offers: {
    heading: (count: number) => `OFFERS AND ORDERS PREPARED YESTERDAY (${count})`,
    offer: (number: string, recipientDomain: string, grossTotal: string) =>
      `- Offer ${number} for ${recipientDomain}, ${grossTotal} including VAT - attached to the reply draft.`,
    confirmLink: (url: string) => `  Accepted by phone or in another way? Prepare the order confirmation: ${url}`,
    accepted: (number: string, recipientDomain: string) => `- Offer ${number} for ${recipientDomain} was accepted.`,
    orderConfirmation: (number: string, recipientDomain: string) =>
      `- Order confirmation ${number} for ${recipientDomain} - attached to a draft.`,
  },

  money: {
    heading: (count: number) => `MONEY DUE AND OVERDUE (${count})`,
    overdue: (number: string, who: string, amount: string, dueDate: string, days: number) =>
      `- Invoice ${number} to ${who}: ${amount}, due ${dueDate}, ${days} day(s) overdue.`,
    dueSoon: (number: string, who: string, amount: string, dueDate: string) =>
      `- Invoice ${number} to ${who}: ${amount}, due ${dueDate}.`,
    reminderInOutlook: (level: number) => `  Reminder ${level} of 3 is in your Outlook Drafts.`,
    reminderByEmail: (level: number) => `  Reminder ${level} of 3 was emailed to you.`,
    paidLink: (url: string) => `  Paid already, or stop reminders for it: ${url}`,
    more: (count: number) => `- ...and ${count} more open invoice(s).`,
    askDueDate: (number: string, who: string, amount: string, url: string) =>
      `- Invoice ${number} to ${who} (${amount}): no due date could be read from it, so no reminders are planned. Set the due date here: ${url}`,
    unreadable: (fileName: string) =>
      `- "${fileName}" looks like an invoice you sent, but it could not be read (a scan or a picture), so it is not tracked.`,
    paidBySender: (number: string, who: string, amount: string) =>
      `- Invoice ${number} to ${who} (${amount}): the customer wrote that it has been paid. Reminders have stopped; please check your bank.`,
  },

  suspicious: {
    heading: (count: number) => `LOOKED SUSPICIOUS (${count})`,
    mail: (subject: string, senderDomain: string) => `- "${subject}" (from ${senderDomain})`,
    hint: "  These emails contain text that tries to give instructions to an automated assistant. Nothing in them was acted on and no reply was prepared. Read them with care before you answer.",
  },

  wentQuiet: {
    heading: (count: number) => `WENT QUIET (${count})`,
    chaserReady: (subject: string, counterpartDomain: string, workingDays: number) =>
      `- "${subject}" (to ${counterpartDomain}): no answer for ${workingDays} working days. A follow-up draft is in your Outlook Drafts.`,
    notThisTime: (url: string) => `  Not this time: ${url}`,
    neverForThread: (url: string) => `  Never for this thread: ${url}`,
    noMoreChasers: (subject: string, counterpartDomain: string, chasers: number) =>
      `- "${subject}" (to ${counterpartDomain}): still no answer after ${chasers} follow-ups. No more follow-ups will be drafted for this thread.`,
    deleteHint: "Deleting a follow-up draft in Outlook also counts as \"not this time\".",
  },

  filed: {
    heading: (count: number) => `FILED YESTERDAY (${count})`,
    document: (documentType: string, fileName: string, folder: string) => `- ${documentType}: ${fileName} -> ${folder}`,
  },

  problems: {
    heading: "CONNECTION PROBLEMS",
    mailboxDisconnected: (emailAddress: string, settingsUrl: string) =>
      `- Your Microsoft 365 mailbox ${emailAddress} is disconnected, so new mail is not being read. Reconnect it here: ${settingsUrl}`,
    filingOff: (count: number, settingsUrl: string) =>
      `- ${count} attachment(s) arrived yesterday and were not filed, because your Microsoft 365 connection was made before filing existed. Reconnect once to switch filing on: ${settingsUrl}`,
    driveUnreachable: (count: number, settingsUrl: string) =>
      `- Your OneDrive could not be reached. ${count} attachment(s) are waiting and will be filed automatically once it works again. If this stays, reconnect here: ${settingsUrl}`,
  },
};

export type BriefStrings = typeof en;
