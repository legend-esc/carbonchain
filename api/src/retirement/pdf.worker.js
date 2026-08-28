/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Worker thread for synchronous PDF generation.
 * Receives CertificateData via workerData, posts the resulting Buffer back.
 *
 * Issue #493 fix:
 *  - All PDF generation is wrapped in try/catch.
 *  - Errors are posted back to the parent via parentPort.postMessage({ error })
 *    instead of throwing to the uncaught exception handler.
 *  - This prevents the worker from dying silently and propagates the error
 *    cleanly to the CertificateService.buildPdf promise.
 */
const { workerData, parentPort } = require('worker_threads');
const PDFDocument = require('pdfkit');

function run() {
  const data = workerData;
  const doc = new PDFDocument({ margin: 60, size: 'A4' });
  const chunks = [];

  doc.on('data', (chunk) => chunks.push(chunk));

  doc.on('end', () => {
    try {
      parentPort.postMessage(Buffer.concat(chunks));
    } catch (sendErr) {
      // Nothing further we can do if postMessage itself fails.
      process.stderr.write(`pdf.worker: postMessage failed: ${sendErr.message}\n`);
    }
  });

  // Issue #493 fix: catch doc-level errors and forward them instead of throwing.
  doc.on('error', (err) => {
    parentPort.postMessage({ error: err.message });
  });

  try {
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
    // Issue #589 — display vintage year when available for compliance auditing.
    if (data.vintageYear) {
      field('Credit Vintage Year', String(data.vintageYear));
    }
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
  } catch (err) {
    // Issue #493 fix: synchronous errors during generation are caught and
    // forwarded to the parent process.
    parentPort.postMessage({ error: err.message || String(err) });
  }
}

run();
