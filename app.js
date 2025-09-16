require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

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
      '--no-zygote',
    ],
  });
  console.log('Navegador Puppeteer iniciado.');
}

async function stopBrowser() {
  if (browser) {
    await browser.close();
    console.log('Navegador Puppeteer cerrado.');
  }
}

async function fetchWithPuppeteer(url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
    const bodyText = await page.evaluate(() => document.body.innerText);
    try {
      return JSON.parse(bodyText);
    } catch (error) {
      console.error(`Error parseando JSON desde ${url}:`, error.message);
      console.error('Contenido recibido (primeros 500 caracteres):', bodyText.slice(0, 500));
      throw new Error('La API no devolvió una respuesta JSON válida.');
    }
  } catch (error) {
    console.error(`Error en Puppeteer al cargar ${url}:`, error.message);
    throw error;
  } finally {
    await page.close();
  }
}

async function verifyProperty(lat, lng) {
  try {
    console.log(`Verificando propiedad lat:${lat}, lng:${lng}`);
    const baseUrl = `https://epok.buenosaires.gob.ar/catastro/parcela/?lng=${lng}&lat=${lat}`;
    const data = await fetchWithPuppeteer(baseUrl);

    if (data.propiedad_horizontal === 'Si') {
      const phData = await fetchWithPuppeteer(`${baseUrl}&ph`);
      if (phData.phs && phData.phs.length > 0) {
        return { status: 'success', message: 'La partida existe', phs: phData.phs };
      }
      return { status: 'error', message: 'La partida no existe (sin unidades funcionales)' };
    } else if (data.pdamatriz) {
      const pdamatriz = data.pdamatriz;
      return { status: 'success', message: 'La partida existe', pdamatriz };
    }

    return { status: 'error', message: 'La partida no existe' };
  } catch (error) {
    console.error('Error verificando propiedad:', error.message);
    throw error;
  }
}

async function fetchVfhData(lat, lng) {
  try {
    console.log(`Obteniendo datos VFH-CABA lat:${lat}, lng:${lng}`);
    const baseUrl = `https://epok.buenosaires.gob.ar/catastro/parcela/?lng=${lng}&lat=${lat}`;
    const data = await fetchWithPuppeteer(baseUrl);

    if (data.propiedad_horizontal === 'Si') {
      const phData = await fetchWithPuppeteer(`${baseUrl}&ph`);
      return phData.phs
        ? phData.phs.map(ph => ({
            pdahorizontal: ph.pdahorizontal,
            piso: ph.piso,
            dpto: ph.dpto,
          }))
        : null;
    } else if (data.pdamatriz) {
      return data.pdamatriz;
    }

    console.error('No se encontraron datos válidos.');
    return null;
  } catch (error) {
    console.error('Error obteniendo datos VFH-CABA:', error.message);
    throw error;
  }
}

async function sendEmail(email, data) {
  const makeAgipUrl = (partida, dv = '') => {
    const p = encodeURIComponent(String(partida));
    let url = `https://lb.agip.gob.ar/ConsultaABL/?inputDom=${p}&inputDom2=${p}`;
    if (dv) url += `&DV=${encodeURIComponent(dv)}&chkPartida2Dv=on`;
    return url;
  };

  const instructionsText =
    `Instrucciones:\n` +
    `1) Copiá el número de partida.\n` +
    `2) Hacé click en el link "Consultar VFH" junto a la partida.\n` +
    `3) En la página de AGIP pegá (Ctrl+V) el número en "Partida" y "Reingrese partida".\n` +
    `4) Completá el captcha y presioná CONSULTAR.\n`;

  const instructionsHtml = `
    <p style="font-size:1rem;margin-bottom:0.5rem;"><strong>Instrucciones:</strong></p>
    <ol style="text-align:left;margin:0 0 1rem 1.25rem;padding:0;">
      <li>Copiá el número de partida.</li>
      <li>Hacé click en el link <em>"Consultar VFH"</em> junto a la partida.</li>
      <li>En la página de AGIP pegá (Ctrl+V) el número en <em>Partida</em> y <em>Reingrese partida</em>.</li>
      <li>Completá el captcha y presioná <em>CONSULTAR</em>.</li>
    </ol>
  `;

  let dataText = '';
  let dataHtml = '';

  const headerHtml = `
    <div style="padding:1rem;text-align:center;">
      <img src="https://proprop.com.ar/wp-content/uploads/2025/09/vfh-capital-min.jpg"
           alt="PROPROP VFH CABA"
           style="max-width:100%;height:auto;display:block;margin:0 auto 1rem;">
      <h2 style="margin:0 0 0.5rem;">Resultados de su consulta VFH CABA</h2>
      <p style="margin:0 0 1rem;">A continuación encontrará la(s) partida(s) encontrada(s) para la ubicación solicitada.</p>
    </div>
  `;

  if (Array.isArray(data)) {
    const linesText = data
      .map(item => {
        const partida = item.pdahorizontal ?? '';
        const piso = item.piso || '';
        const dpto = item.dpto || '';
        return `Partida: ${partida}${piso || dpto ? ` | Piso: ${piso}${dpto ? ` | Dpto: ${dpto}` : ''}` : ''}`;
      })
      .join('\n');

    dataText =
      instructionsText +
      '\n' +
      linesText +
      '\n\nIr a AGIP: https://lb.agip.gob.ar/ConsultaABL/\n\n' +
      'Te llegó este correo porque solicitaste los números de partida al servicio de consultas de ProProp.';

    const listHtmlItems = data
      .map(item => {
        const partida = item.pdahorizontal ?? '';
        const piso = item.piso || '';
        const dpto = item.dpto || '';
        const agipUrl = makeAgipUrl(partida);
        return `
          <li style="margin-bottom:0.75rem;display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div style="text-align:left;">
              <strong>Partida:</strong> ${partida}
              ${piso || dpto ? `<div style="font-size:0.9rem;color:#555;">Piso: ${piso}${dpto ? ` | Dpto: ${dpto}` : ''}</div>` : ''}
            </div>
            <div>
              <a href="${agipUrl}" target="_blank" rel="noopener noreferrer"
                 style="display:inline-block;padding:10px 14px;background:#0069d9;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">
                Consultar VFH
              </a>
            </div>
          </li>
        `;
      })
      .join('');

    dataHtml = `
      ${headerHtml}
      <div style="padding:1rem;">
        ${instructionsHtml}
        <ul style="list-style:none;padding:0;margin:0 0 1rem 0;">
          ${listHtmlItems}
        </ul>
        <hr style="margin:1rem 0;">
        <p style="font-size:0.9rem;color:#666;">
          Enlace directo a AGIP: <a href="https://lb.agip.gob.ar/ConsultaABL/" target="_blank" rel="noopener noreferrer">Consulta ABL - AGIP</a>
        </p>
        <p style="font-size:0.8rem;color:#777;font-style:italic;">
          Te llegó este correo porque solicitaste los números de partida al servicio de consultas de ProProp.
        </p>
      </div>
    `;
  } else {
    const partida = String(data);
    const agipUrl = makeAgipUrl(partida);

    dataText =
      instructionsText +
      '\n' +
      `Partida: ${partida}\n` +
      `Consultar en: https://lb.agip.gob.ar/ConsultaABL/\n\n` +
      'Te llegó este correo porque solicitaste tu número de partida al servicio de consultas de ProProp.';

    dataHtml = `
      ${headerHtml}
      <div style="padding:1rem;text-align:center;">
        ${instructionsHtml}
        <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:8px;">
          <div style="text-align:left;">
            <p style="margin:0 0 0.25rem 0;"><strong>Partida:</strong> ${partida}</p>
          </div>
          <div>
            <a href="${agipUrl}" target="_blank" rel="noopener noreferrer"
               style="display:inline-block;padding:12px 16px;background:#0069d9;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">
              Consultar VFH
            </a>
          </div>
        </div>
        <hr style="margin:1rem 0;">
        <p style="font-size:0.9rem;color:#666;">
          Enlace directo a AGIP:
          <a href="https://lb.agip.gob.ar/ConsultaABL/" target="_blank" rel="noopener noreferrer">Consulta ABL - AGIP</a>
        </p>
        <p style="font-size:0.8rem;color:#777;font-style:italic;">
          Te llegó este correo porque solicitaste tu número de partida al servicio de consultas de ProProp.
        </p>
      </div>
    `;
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: { user: process.env.BREVO_USER, pass: process.env.BREVO_PASS },
  });

  const mailOptions = {
    from: '"PROPROP" <ricardo@proprop.com.ar>',
    to: email,
    bcc: 'info@proprop.com.ar',
    subject: 'Consulta VFH CABA - Partida(s) encontrada(s)',
    text: dataText,
    html: dataHtml,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log('Correo VFH-CABA enviado:', info.messageId);
}

app.use(express.json());

async function handleFetch(req, res) {
  const { lat, lng, email } = req.body || {};
  try {
    const data = await fetchVfhData(lat, lng);
    if (!data) return res.status(502).json({ error: 'No se pudo obtener la partida (matriz o PH).' });

    try {
      await sendEmail(email, data);
    } catch (e) {
      console.error('Error sendEmail:', e.message);
      return res.status(500).json({ error: 'No se pudo enviar el email.' });
    }

    return res.status(200).json({
      message: 'Email VFH-CABA enviado con éxito',
      partidas: Array.isArray(data) ? data : String(data),
    });
  } catch (e) {
    console.error('Error en handleFetch:', e);
    return res.status(500).json({ error: 'Error procesando la solicitud VFH-CABA' });
  }
}

app.post('/fetch-vfh-caba-data', handleFetch);
app.post('/fetch-abl-data', handleFetch);

app.post('/verification', async (req, res) => {
  const { lat, lng } = req.body || {};
  try {
    const result = await verifyProperty(lat, lng);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error en /verification:', error);
    return res.status(500).json({ status: 'error', message: 'Error verificando la existencia de la partida' });
  }
});

app.get('/', (req, res) => {
  res.status(200).json({ ok: true, service: 'vfh-caba', time: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

startBrowser()
  .then(() => {
    const server = app.listen(port, () => {
      console.log(`Servidor VFH-CABA escuchando en puerto ${port}`);
    });
    server.setTimeout(20000);
    process.on('SIGINT', async () => {
      console.log('Apagando servidor…');
      await stopBrowser();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      console.log('Terminación recibida…');
      await stopBrowser();
      process.exit(0);
    });
  })
  .catch(error => {
    console.error('Error iniciando Puppeteer:', error.message);
    process.exit(1);
  });
