// Modèles d'e-mails IFRIQI (présentation uniquement : aucune logique métier ici).
// Identité : bleu marine #012768, rose magenta #FE4E9A, fond clair #EFF3F9.
// Aucune donnée médicale ni information sensible : prénom, montant, référence, n° public de carte.
export type EmailKind = "welcome" | "payment_confirmed" | "password_reset" | "test";
export interface Rendered { subject: string; html: string; text: string }

const NAVY = "#012768", PINK = "#FE4E9A", BG = "#EFF3F9", INK = "#1b2a4a", MUTED = "#5b6b8c";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

interface Layout { preheader: string; title: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string; supportEmail: string; appUrl: string }

function layout(l: Layout): string {
  const cta = l.ctaLabel && l.ctaUrl
    ? `<tr><td align="center" style="padding:8px 32px 8px"><a href="${esc(l.ctaUrl)}" style="background:${PINK};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:10px;display:inline-block">${esc(l.ctaLabel)}</a></td></tr>
       <tr><td style="padding:12px 32px 0;font-size:12px;color:${MUTED};line-height:1.5">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><a href="${esc(l.ctaUrl)}" style="color:${NAVY};word-break:break-all">${esc(l.ctaUrl)}</a></td></tr>`
    : "";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(l.title)}</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:Arial,Helvetica,sans-serif;color:${INK}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(l.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:${NAVY};padding:22px 32px"><span style="font-size:26px;font-weight:800;letter-spacing:1px;color:#ffffff">IFRI<span style="color:${PINK}">QI</span></span></td></tr>
<tr><td style="padding:28px 32px 8px"><h1 style="margin:0;font-size:22px;line-height:1.3;color:${NAVY}">${esc(l.title)}</h1></td></tr>
<tr><td style="padding:8px 32px 16px;font-size:15px;line-height:1.6">${l.bodyHtml}</td></tr>
${cta}
<tr><td style="padding:28px 32px 24px;font-size:12px;line-height:1.5;color:${MUTED};border-top:1px solid #e3e9f3">
Une question ? Écrivez-nous : <a href="mailto:${esc(l.supportEmail)}" style="color:${NAVY}">${esc(l.supportEmail)}</a><br>
IFRIQI — <a href="${esc(l.appUrl)}" style="color:${NAVY}">${esc(l.appUrl.replace(/^https?:\/\//, ""))}</a><br>
Ce message est automatique : il confirme une action effectuée sur votre compte.</td></tr>
</table></td></tr></table></body></html>`;
}

export interface Ctx { appUrl: string; supportEmail: string }

export function render(kind: EmailKind, data: Record<string, unknown>, ctx: Ctx): Rendered {
  const hello = data.firstName ? `Bonjour ${esc(data.firstName)},` : "Bonjour,";
  const helloTxt = data.firstName ? `Bonjour ${data.firstName},` : "Bonjour,";
  const foot = `\n\nUne question ? ${ctx.supportEmail}\nIFRIQI — ${ctx.appUrl}\nMessage automatique.`;

  if (kind === "welcome") {
    const url = `${ctx.appUrl}/#/auth`;
    return {
      subject: "Bienvenue sur IFRIQI — votre compte est créé",
      html: layout({
        preheader: "Votre compte IFRIQI est prêt.", title: "Bienvenue sur IFRIQI",
        bodyHtml: `<p>${hello}</p><p>Votre compte IFRIQI a bien été créé. Vous pouvez maintenant vous connecter, créer votre carte de secours par QR Code et la garder sur vous.</p>`,
        ctaLabel: "Accéder à mon compte", ctaUrl: url, ...ctx,
      }),
      text: `${helloTxt}\n\nVotre compte IFRIQI a bien été créé. Connectez-vous pour créer votre carte de secours par QR Code :\n${url}${foot}`,
    };
  }

  if (kind === "payment_confirmed") {
    const isCard = data.product === "card";
    const what = isCard ? "votre carte de secours IFRIQI" : "votre recharge de carte IFRIQI";
    const amount = String(data.amountLabel ?? "");
    const ref = String(data.orderRef ?? "");
    const card = data.cardPublicId ? String(data.cardPublicId) : "";
    const url = `${ctx.appUrl}/#/app`;
    const rows = [
      ["Référence de commande", ref], ["Montant payé", amount], ...(card ? [["Numéro de carte", card]] : []),
    ].filter((r) => r[1]);
    const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;background:${BG};border-radius:10px">${rows.map((r) =>
      `<tr><td style="padding:10px 14px;font-size:13px;color:${MUTED}">${esc(r[0])}</td><td align="right" style="padding:10px 14px;font-size:14px;font-weight:700;color:${NAVY}">${esc(r[1])}</td></tr>`).join("")}</table>`;
    return {
      subject: isCard ? "Paiement confirmé — votre carte IFRIQI" : "Paiement confirmé — votre recharge IFRIQI",
      html: layout({
        preheader: `Nous avons bien reçu votre paiement pour ${what}.`, title: "Paiement confirmé",
        bodyHtml: `<p>${hello}</p><p>Nous avons bien reçu votre paiement pour ${esc(what)}.</p>${table}<p>${isCard ? "Votre carte est prête : retrouvez-la, complétez-la et téléchargez-la depuis votre espace." : "Votre recharge est enregistrée sur votre compte."}</p>`,
        ctaLabel: "Ouvrir mon espace", ctaUrl: url, ...ctx,
      }),
      text: `${helloTxt}\n\nNous avons bien reçu votre paiement pour ${what}.\n\n${rows.map((r) => `${r[0]} : ${r[1]}`).join("\n")}\n\nOuvrir mon espace : ${url}${foot}`,
    };
  }

  if (kind === "password_reset") {
    const url = String(data.resetUrl ?? "");
    return {
      subject: "Réinitialisation de votre mot de passe IFRIQI",
      html: layout({
        preheader: "Choisissez un nouveau mot de passe (lien valable 1 heure).", title: "Réinitialiser votre mot de passe",
        bodyHtml: `<p>${hello}</p><p>Nous avons reçu une demande de réinitialisation du mot de passe de votre compte IFRIQI. Ce lien est valable <b>1 heure</b> et ne peut servir qu'une seule fois.</p><p style="color:${MUTED};font-size:13px">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail : votre mot de passe actuel reste inchangé. Ne transmettez ce lien à personne.</p>`,
        ctaLabel: "Choisir un nouveau mot de passe", ctaUrl: url, ...ctx,
      }),
      text: `${helloTxt}\n\nNous avons reçu une demande de réinitialisation du mot de passe de votre compte IFRIQI. Ce lien est valable 1 heure et ne peut servir qu'une seule fois :\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé. Ne transmettez ce lien à personne.${foot}`,
    };
  }

  // test
  return {
    subject: "Test d'envoi IFRIQI", 
    html: layout({ preheader: "Test technique.", title: "Test d'envoi réussi", bodyHtml: `<p>Ce message confirme que l'envoi d'e-mails IFRIQI via Resend fonctionne.</p>`, ...ctx }),
    text: `Ce message confirme que l'envoi d'e-mails IFRIQI via Resend fonctionne.${foot}`,
  };
}
