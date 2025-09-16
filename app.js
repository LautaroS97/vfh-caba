require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');

const app = express();
const port = 3000;

let browser;

async function startBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote'
    ]
  });
}

async function stopBrowser() {
  if (browser) {
    await browser.close();
  }
}

async function fetchWithPuppeteer(url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
    const bodyText = await page.evaluate(() => document.body.innerText);
    return JSON.parse(bodyText);
  } finally {
    await page.close();
  }
}

async function verifyProperty(lat, lng) {
  const baseUrl = `https://epok.buenosaires.gob.ar/catastro/parcela/?lng=${lng}&lat=${lat}`;
  const data = await fetchWithPuppeteer(baseUrl);
  if (data.propiedad_horizontal === "Si") {
    const phData = await fetchWithPuppeteer(`${baseUrl}&ph`);
    if (phData.phs && phData.phs.length > 0) {
      return { status: 'success', message: 'La partida existe', phs: phData.phs };
    } else {
      return { status: 'error', message: 'La partida no existe (sin unidades funcionales)' };
    }
  } else if (data.pdamatriz) {
    const pdamatriz = data.pdamatriz;
    return { status: 'success', message: 'La partida existe', pdamatriz };
  }
  return { status: 'error', message: 'La partida no existe' };
}

async function fetchVfhCabaData(lat, lng) {
  const baseUrl = `https://epok.buenosaires.gob.ar/catastro/parcela/?lng=${lng}&lat=${lat}`;
  const data = await fetchWithPuppeteer(baseUrl);
  if (data.propiedad_horizontal === "Si") {
    const phData = await fetchWithPuppeteer(`${baseUrl}&ph`);
    return phData.phs ? phData.phs.map(ph => ({
      pdahorizontal: ph.pdahorizontal,
      piso: ph.piso,
      dpto: ph.dpto
    })) : null;
  } else if (data.pdamatriz) {
    return data.pdamatriz;
  }
  return null;
}

async function sendEmail(email, data) {
  const instructionsText =
    `Instrucciones:\n` +
    `1) Copiá el número de partida.\n` +
    `2) Hacé click en el botón "Consultar VFH" junto a la partida.\n` +
    `3) En la página de AGIP pegá el número en "Partida" y "Reingrese partida".\n` +
    `4) Completá el captcha y presioná CONSULTAR.\n`;

  const headerHtml = `
    <div style="padding:1rem;text-align:center;">
      <img src="https://proprop.com.ar/wp-content/uploads/2025/09/vfh-capital-min.jpg" alt="VFH CABA" style="max-width:100%;height:auto;display:block;margin:0 auto 1rem;">
      <h2 style="margin:0 0 .5rem;font-family:Arial,Helvetica,sans-serif;">Resultados de tu consulta VFH CABA</h2>
      <p style="margin:.25rem 0 1rem;font-family:Arial,Helvetica,sans-serif;">A continuación encontrarás la(s) partida(s) detectada(s) para la ubicación.</p>
    </div>
  `;

  const instructionsHtml = `
    <div style="text-align:left;font-family:Arial,Helvetica,sans-serif;">
      <p style="margin:.5rem 0;"><strong>Instrucciones</strong></p>
      <ol style="margin:.25rem 0 1rem 1.25rem;padding:0;">
        <li>Copiá el número de partida.</li>
        <li>Hacé click en el botón <em>"Consultar VFH"</em> junto a la partida.</li>
        <li>Pegá el número en <em>Partida</em> y <em>Reingrese partida</em>.</li>
        <li>Completá el captcha y presioná <em>CONSULTAR</em>.</li>
      </ol>
    </div>
  `;

  const agipBase = 'https://lb.agip.gob.ar/ConsultaABL/';

  let dataText = '';
  let dataHtml = '';

  if (Array.isArray(data)) {
    const linesText = data.map(item => {
      const partida = item.pdahorizontal ?? '';
      const piso = item.piso || '';
      const dpto = item.dpto || '';
      return `Partida: ${partida}${piso || dpto ? ` | Piso: ${piso}${dpto ? ` | Dpto: ${dpto}` : ''}` : ''}`;
    }).join('\n');

    dataText =
      instructionsText +
      '\n' +
      linesText +
      '\n\nIr a AGIP: https://lb.agip.gob.ar/ConsultaABL/\n\n' +
      'Te llegó este correo porque solicitaste la valuación fiscal homogénea al servicio de consultas de ProProp.';

    const listHtmlItems = data.map(item => {
      const partida = item.pdahorizontal ?? '';
      const piso = item.piso || '';
      const dpto = item.dpto || '';
      return `
        <li style="margin:0 0 .75rem 0;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div style="text-align:left;font-family:Arial,Helvetica,sans-serif;">
            <div><strong>Partida:</strong> ${partida}</div>
            ${piso || dpto ? `<div style="font-size:.9rem;color:#555;">Piso: ${piso}${dpto ? ` | Dpto: ${dpto}` : ''}</div>` : ''}
          </div>
          <a href="${agipBase}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 14px;background:#0b5ed7;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">Consultar VFH</a>
        </li>
      `;
    }).join('');

    dataHtml = `
      ${headerHtml}
      <div style="padding:1rem;">
        ${instructionsHtml}
        <ul style="list-style:none;margin:0;padding:0;">
          ${listHtmlItems}
        </ul>
        <hr style="margin:1rem 0;border:0;border-top:1px solid #e5e7eb;">
        <p style="font-size:.9rem;color:#555;font-family:Arial,Helvetica,sans-serif;">
          Enlace directo a AGIP: <a href="${agipBase}" target="_blank" rel="noopener noreferrer">Consulta ABL - AGIP</a>
        </p>
        <p style="font-size:.8rem;color:#777;font-style:italic;font-family:Arial,Helvetica,sans-serif;">
          Te llegó este correo porque solicitaste la valuación fiscal homogénea al servicio de consultas de ProProp.
        </p>
      </div>
    `;
  } else {
    const partida = String(data);
    dataText =
      instructionsText +
      '\n' +
      `Partida: ${partida}\n` +
      `Consultar en: https://lb.agip.gob.ar/ConsultaABL/\n\n` +
      'Te llegó este correo porque solicitaste la valuación fiscal homogénea al servicio de consultas de ProProp.';

    dataHtml = `
      ${headerHtml}
      <div style="padding:1rem;text-align:center;font-family:Arial,Helvetica,sans-serif;">
        ${instructionsHtml}
        <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:8px;">
          <div style="text-align:left;margin-right:1rem;">
            <p style="margin:0 0 .25rem 0;"><strong>Partida:</strong> ${partida}</p>
          </div>
          <a href="${agipBase}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 16px;background:#0b5ed7;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Consultar VFH</a>
        </div>
        <hr style="margin:1rem 0;border:0;border-top:1px solid #e5e7eb;">
        <p style="font-size:.9rem;color:#555;">
          Enlace directo a AGIP: <a href="${agipBase}" target="_blank" rel="noopener noreferrer">Consulta ABL - AGIP</a>
        </p>
        <p style="font-size:.8rem;color:#777;font-style:italic;">
          Te llegó este correo porque solicitaste la valuación fiscal homogénea al servicio de consultas de ProProp.
        </p>
      </div>
    `;
  }

  const transporter = nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.BREVO_USER,
      pass: process.env.BREVO_PASS
    },
    tls: { rejectUnauthorized: false }
  });

  const mailOptions = {
    from: '"PROPROP" <ricardo@proprop.com.ar>',
    to: email,
    bcc: 'info@proprop.com.ar',
    subject: "Consulta VFH CABA",
    text: dataText,
    html: dataHtml
  };

  const info = await transporter.sendMail(mailOptions);
  return info && info.messageId ? info.messageId : null;
}

app.use(express.json());

app.post('/fetch-vfh-data', async (req, res) => {
  const { lat, lng, email } = req.body;
  try {
    const partidas = await fetchVfhCabaData(lat, lng);
    if (partidas) {
      await sendEmail(email, partidas);
      res.send({ message: 'Email enviado con éxito', partidas });
    } else {
      res.status(500).send({ error: 'No se pudo obtener el número de partida matriz o datos de propiedad horizontal.' });
    }
  } catch {
    res.status(500).send({ error: 'Error procesando la solicitud' });
  }
});

app.post('/verification', async (req, res) => {
  const { lat, lng } = req.body;
  try {
    const result = await verifyProperty(lat, lng);
    res.send(result);
  } catch {
    res.status(500).send({ status: 'error', message: 'Error verificando la existencia de la partida' });
  }
});

startBrowser()
  .then(() => {
    const server = app.listen(port, () => {});
    server.setTimeout(20000);
    process.on('SIGINT', async () => {
      await stopBrowser();
      process.exit();
    });
  })
  .catch(() => {
    process.exit(1);
  });
