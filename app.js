require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');

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

  if (data.propiedad_horizontal === 'Si') {
    const phData = await fetchWithPuppeteer(`${baseUrl}&ph`);

    if (phData.phs && phData.phs.length > 0) {
      return { status: 'success', message: 'La partida existe', phs: phData.phs };
    }

    return { status: 'error', message: 'La partida no existe (sin unidades funcionales)' };
  }

  if (data.pdamatriz) {
    return { status: 'success', message: 'La partida existe', pdamatriz: data.pdamatriz };
  }

  return { status: 'error', message: 'La partida no existe' };
}

async function fetchVfhCabaData(lat, lng) {
  const baseUrl = `https://epok.buenosaires.gob.ar/catastro/parcela/?lng=${lng}&lat=${lat}`;
  const data = await fetchWithPuppeteer(baseUrl);

  if (data.propiedad_horizontal === 'Si') {
    const phData = await fetchWithPuppeteer(`${baseUrl}&ph`);

    if (phData.phs && phData.phs.length > 0) {
      const partidas = phData.phs.map(ph => ({
        pdahorizontal: ph.pdahorizontal,
        piso: ph.piso,
        dpto: ph.dpto
      }));

      return {
        type: 'horizontal_property',
        partidas
      };
    }

    return null;
  }

  if (data.pdamatriz) {
    return {
      type: 'single',
      pdamatriz: data.pdamatriz
    };
  }

  return null;
}

app.use(express.json());

app.post('/fetch-vfh-data', async (req, res) => {
  const { lat, lng, email, address } = req.body;

  try {
    const result = await fetchVfhCabaData(lat, lng);

    if (!result) {
      return res.status(500).send({
        success: false,
        service: 'vfh_caba',
        error: 'No se pudo obtener el número de partida matriz o datos de propiedad horizontal.',
        email,
        address,
        lat,
        lng
      });
    }

    const response = {
      success: true,
      service: 'vfh_caba',
      message: 'Datos VFH CABA obtenidos correctamente',
      result,
      email,
      address,
      lat,
      lng
    };

    if (result.type === 'horizontal_property') {
      response.partidas = result.partidas;
    }

    if (result.type === 'single') {
      response.pdamatriz = result.pdamatriz;
      response.partidas = result.pdamatriz;
    }

    return res.send(response);
  } catch (error) {
    return res.status(500).send({
      success: false,
      service: 'vfh_caba',
      error: 'Error procesando la solicitud',
      details: error.message || String(error),
      email,
      address,
      lat,
      lng
    });
  }
});

app.post('/verification', async (req, res) => {
  const { lat, lng } = req.body;

  try {
    const result = await verifyProperty(lat, lng);
    res.send(result);
  } catch (error) {
    res.status(500).send({
      status: 'error',
      message: 'Error verificando la existencia de la partida',
      details: error.message || String(error)
    });
  }
});

startBrowser()
  .then(() => {
    const server = app.listen(port, () => {});
    server.setTimeout(60000);

    process.on('SIGINT', async () => {
      await stopBrowser();
      process.exit();
    });
  })
  .catch(() => {
    process.exit(1);
  });
