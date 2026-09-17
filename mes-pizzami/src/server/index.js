/**
 * MES Pizzami - server HTTP.
 * Serve l'API JSON (/api/...) e l'interfaccia tablet (file statici in src/web).
 * Avvio: npm start   (legge .env se presente)
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getContext, getPool, HttpError } from './db.js';
import metaRoutes from './routes/meta.js';
import productRoutes from './routes/products.js';
import palletRoutes from './routes/pallets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Parser GS1 condiviso: lo stesso file usato dal server viene servito al browser
app.use('/gs1', express.static(path.join(here, '..', 'gs1'), { index: false }));
app.use(express.static(path.join(here, '..', 'web')));

app.use('/api', metaRoutes);
app.use('/api', productRoutes);
app.use('/api', palletRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Endpoint non trovato: ${req.method} ${req.originalUrl}` });
});

// Gestione errori centralizzata (Express 5 intercetta anche i reject delle route async)
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON non valido' });
  }
  console.error(err);
  return res.status(500).json({ error: 'Errore interno del server' });
});

const port = Number(process.env.PORT || 3000);

getPool()
  .then(() => getContext())
  .then((ctx) => {
    app.listen(port, () => {
      console.log(`MES Pizzami: ${ctx.tenantName} / ${ctx.plantName}`);
      console.log(`Interfaccia tablet: http://localhost:${port}/`);
    });
  })
  .catch((err) => {
    console.error('Impossibile avviare: ' + err.message);
    process.exit(1);
  });
