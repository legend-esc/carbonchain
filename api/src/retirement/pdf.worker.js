/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Worker thread for synchronous PDF generation.
 * Receives CertificateData via workerData, posts the resulting Buffer back.
 */
const { workerData, parentPort } = require('worker_threads');
const PDFDocument = require('pdfkit');

const data = workerData;
const doc = new PDFDocument({ margin: 60, size: 'A4' });
const chunks = [];

doc.on('data', (chunk) => chunks.push(chunk));
doc.on('end', () => {
  parentPort.postMessage(Buffer.concat(chunks));
});
doc.on('error', (err) => {
  throw err;
});

const retiredAt = new Date(data.timestamp * 1000).toUTCString();
const tonnesDisplay = (Number(data.tonnes) / 1_000_000).toFixed(1);

doc
  .fontSize(24)
  .font('Helvetica-Bold')
  .text('Carbon Credit Retirement Certificate', { align: 'center' });

doc.moveDown(0.5);
doc
  .fontSize(12)
  .font('Helvetica')
  .fillColor('#555555')
  .text('Issued by CarbonChain on the Stellar Network', { align: 'center' });

doc.moveDown(1.5);
doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#cccccc').stroke();
doc.moveDown(1);

doc.fillColor('#000000').fontSize(12).font('Helvetica-Bold');

const field = (label, value) => {
  doc.font('Helvetica-Bold').text(`${label}:`, { continued: true });
  doc.font('Helvetica').text(`  ${value}`);
  doc.moveDown(0.4);
};

field('Retirement ID', data.retirementId);
field('Credit ID', data.creditId);
field('Buyer', data.buyer);
field('Tonnes Retired', `${tonnesDisplay} tonne(s)`);
field('Reason', data.reason);
field('Retired At', retiredAt);

doc.moveDown(2);
doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#cccccc').stroke();
doc.moveDown(0.5);
doc
  .fontSize(9)
  .fillColor('#888888')
  .text(
    'This certificate is permanently recorded on the Stellar blockchain and cannot be altered.',
    { align: 'center' },
  );

doc.end();
