import QRCode from 'qrcode';
import type { EmailAttachment } from './types.js';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const mnt = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}₮`;

export interface ReceiptEmailData {
  orderId: string;
  description: string;
  amount: number;
  items: { name: string; qty: number; unitPrice: number }[];
  ebarimtId: string;
  lottery?: string | null;
  qrData?: string | null;
  date?: string | null;
}

export async function renderReceiptEmail(d: ReceiptEmailData) {
  const attachments: EmailAttachment[] = [];
  if (d.qrData) {
    const png = await QRCode.toBuffer(d.qrData, { width: 280, margin: 1 });
    attachments.push({ filename: 'ebarimt-qr.png', contentBase64: png.toString('base64'), contentType: 'image/png', contentId: 'ebarimt-qr' });
  }

  const rows = d.items
    .map(
      (i) =>
        `<tr><td style="padding:4px 0">${escape(i.name)} × ${i.qty}</td><td style="padding:4px 0;text-align:right">${mnt(i.qty * i.unitPrice)}</td></tr>`,
    )
    .join('');

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;max-width:560px;margin:auto">
<h2>Төлбөр амжилттай төлөгдлөө</h2>
<p>${escape(d.description)}</p>
<table style="width:100%;border-collapse:collapse">${rows}
<tr><td style="padding-top:8px;border-top:1px solid #ddd"><b>Нийт</b></td><td style="padding-top:8px;border-top:1px solid #ddd;text-align:right"><b>${mnt(d.amount)}</b></td></tr></table>
<h3>И-баримт</h3>
<p>ДДТД: <code>${escape(d.ebarimtId)}</code><br>${d.lottery ? `Сугалааны дугаар: <b>${escape(d.lottery)}</b><br>` : ''}${d.date ? `Огноо: ${escape(d.date)}` : ''}</p>
${d.qrData ? '<p><img src="cid:ebarimt-qr" width="200" height="200" alt="Ebarimt QR"></p><p style="font-size:12px;color:#666">Ebarimt аппаар QR кодыг уншуулж баримтаа бүртгүүлнэ үү.</p>' : ''}
<p style="font-size:12px;color:#999">Захиалгын дугаар: ${escape(d.orderId)}</p>
</body></html>`;

  const text = [
    'Төлбөр амжилттай төлөгдлөө',
    d.description,
    ...d.items.map((i) => `${i.name} x ${i.qty}: ${mnt(i.qty * i.unitPrice)}`),
    `Нийт: ${mnt(d.amount)}`,
    '',
    `И-баримт ДДТД: ${d.ebarimtId}`,
    d.lottery ? `Сугалааны дугаар: ${d.lottery}` : '',
    `Захиалгын дугаар: ${d.orderId}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { subject: `Таны төлбөрийн баримт — ${d.description}`, html, text, attachments };
}
