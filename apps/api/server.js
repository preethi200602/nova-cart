const express = require('express');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(require('cors')());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));