require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');

const app = express();
const port = 3000;

// Instancia compartida de Puppeteer
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

// Función para realizar solicitudes con Puppeteer
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

// Verificar propiedad usando Puppeteer
async function verifyProperty(lat, lng) {
    try {
        console.log(`Verificando propiedad en lat: ${lat}, lng: ${lng}`);
        const baseUrl = `https://epok.buenosaires.gob.ar/catastro/parcela/?lng=${lng}&lat=${lat}`;
        const data = await fetchWithPuppeteer(baseUrl);

        if (data.propiedad_horizontal === "Si") {
            console.log('Propiedad horizontal detectada. Verificando unidades funcionales...');
            const phData = await fetchWithPuppeteer(`${baseUrl}&ph`);
            if (phData.phs && phData.phs.length > 0) {
                return { status: 'success', message: 'La partida existe', phs: phData.phs };
            } else {
                return { status: 'error', message: 'La partida no existe (sin unidades funcionales)' };
            }
        } else if (data.pdamatriz) {
            const pdamatriz = data.pdamatriz;
            console.log(`Número de partida matriz obtenido: ${pdamatriz}`);
            return { status: 'success', message: 'La partida existe', pdamatriz };
        }

        return { status: 'error', message: 'La partida no existe' };
    } catch (error) {
        console.error('Error verificando propiedad:', error.message);
        throw error;
    }
}

// Obtener datos de ABL usando Puppeteer
async function fetchAblData(lat, lng) {
    try {
        console.log(`Obteniendo datos de ABL para lat: ${lat}, lng: ${lng}`);
        const baseUrl = `https://epok.buenosaires.gob.ar/catastro/parcela/?lng=${lng}&lat=${lat}`;
        const data = await fetchWithPuppeteer(baseUrl);

        if (data.propiedad_horizontal === "Si") {
            console.log('Propiedad horizontal detectada. Obteniendo datos adicionales...');
            const phData = await fetchWithPuppeteer(`${baseUrl}&ph`);
            return phData.phs ? phData.phs.map(ph => ({
                pdahorizontal: ph.pdahorizontal,
                piso: ph.piso,
                dpto: ph.dpto
            })) : null;
        } else if (data.pdamatriz) {
            return data.pdamatriz;
        }

        console.error('No se encontraron datos válidos.');
        return null;
    } catch (error) {
        console.error('Error obteniendo datos de ABL:', error.message);
        throw error;
    }
}

// Enviar email
async function sendEmail(email, data) {
    let dataText, dataHtml;

    if (Array.isArray(data)) {
        const dataFormatted = data.map(item => `Partida: ${item.pdahorizontal}, Piso: ${item.piso}, Dpto: ${item.dpto}`).join('\n');
        const dataFormattedHtml = data.map(item => `<li>Partida: <b>${item.pdahorizontal}</b>, Piso: <b>${item.piso}</b>, Dpto: <b>${item.dpto}</b></li>`).join('');

        dataText = `Los números de partida son:\n${dataFormatted}\n\nTe llegó este correo porque solicitaste los números de partida al servicio de consultas de ProProp.`;
        dataHtml = `
            <div style="padding: 1rem; text-align: center;">
                <img src="https://proprop.com.ar/wp-content/uploads/2024/06/Logo-email.jpg" style="width: 100%; padding: 1rem;" alt="Logo PROPROP">
                <p>Los números de partida son:</p>
                <ul style="text-align: left; padding-left: 2rem;">
                    ${dataFormattedHtml}
                </ul>
                <hr>
                <p>Puedes utilizar esta información para realizar consultas adicionales en la AGIP, haciendo <a href="https://lb.agip.gob.ar/ConsultaABL/">clic acá.</a></p>
                <p style="margin-top: 1rem; font-size: 0.8rem; font-style: italic;">Te llegó este correo porque solicitaste los números de partida al servicio de consultas de ProProp.</p>
            </div>
        `;
    } else {
        dataText = `El número de partida es:\n${data}\n\nTe llegó este correo porque solicitaste tu número de partida al servicio de consultas de ProProp.`;
        dataHtml = `
            <div style="padding: 1rem; text-align: center;">
                <img src="https://proprop.com.ar/wp-content/uploads/2024/06/Logo-email.jpg" style="width: 100%; padding: 1rem;" alt="Logo PROPROP">
                <p>El número de partida es:<br><b>${data}</b></p>
                <hr>
                <p>Puedes utilizar esta información para realizar consultas adicionales en la AGIP, haciendo <a href="https://lb.agip.gob.ar/ConsultaABL/">clic acá.</a></p>
                <p style="margin-top: 1rem; font-size: 0.8rem; font-style: italic;">Te llegó este correo porque solicitaste tu número de partida al servicio de consultas de ProProp.</p>
            </div>
        `;
    }

    const transporter = nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port: 465,
        secure: true,
        auth: {
            user: process.env.BREVO_USER,
            pass: process.env.BREVO_PASS,
        },
        tls: {
            rejectUnauthorized: false,
        }
    });

    const mailOptions = {
        from: '"PROPROP" <ricardo@proprop.com.ar>',
        to: email,
        bcc: 'info@proprop.com.ar',
        subject: "Consulta de ABL",
        text: dataText,
        html: dataHtml
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Correo enviado:', info.messageId);
    } catch (error) {
        console.error('Error enviando correo:', error.message);
        throw error;
    }
}

app.use(express.json());

// Endpoint para obtener datos de ABL y enviar email
app.post('/fetch-abl-data', async (req, res) => {
    console.log('Received data:', req.body);
    const { lat, lng, email } = req.body;

    try {
        const pdamatriz = await fetchAblData(lat, lng);
        if (pdamatriz) {
            await sendEmail(email, pdamatriz);
            console.log('Email sent with data:', { pdamatriz });
            res.send({ message: 'Email enviado con éxito', pdamatriz });
        } else {
            console.error('No se pudo obtener el número de partida matriz o datos de propiedad horizontal.');
            res.status(500).send({ error: 'No se pudo obtener el número de partida matriz o datos de propiedad horizontal.' });
        }
    } catch (error) {
        console.error('Error en el proceso:', error);
        res.status(500).send({ error: 'Error procesando la solicitud' });
    }
});

// Endpoint para verificar la existencia de una partida
app.post('/verification', async (req, res) => {
    console.log('Received verification request:', req.body);
    const { lat, lng } = req.body;

    try {
        const result = await verifyProperty(lat, lng);
        console.log(result.message);
        res.send(result);
    } catch (error) {
        console.error('Error en la verificación:', error);
        res.status(500).send({ status: 'error', message: 'Error verificando la existencia de la partida' });
    }
});

// Inicializar navegador y servidor
startBrowser()
    .then(() => {
        const server = app.listen(port, () => {
            console.log(`Servidor ejecutándose en el puerto ${port}`);
        });

        server.setTimeout(20000); // 20 segundos

        process.on('SIGINT', async () => {
            console.log('Apagando servidor...');
            await stopBrowser();
            process.exit();
        });
    })
    .catch(error => {
        console.error('Error iniciando Puppeteer:', error.message);
        process.exit(1);
    });