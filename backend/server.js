const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
require('dotenv').config(); // Add this line to load environment variables from .env file

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// MongoDB connection
const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rentalConsultation';
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 45000, socketTimeoutMS: 45000 })
  .then(() => console.log('MongoDB connected...'))
  .catch(err => console.error('MongoDB connection error:', err));

const ConsultationSchema = new mongoose.Schema({
  customerName: String,
  contactDetails: String,
  waiverCompletionTime: Date,
  formLink: String,
  status: { type: String, default: 'Pending' }
});

const Consultation = mongoose.model('Consultation', ConsultationSchema);

// Webhook endpoint for SmartWaiver
app.post('/webhook/waiver-completed', async (req, res) => {
  const waiverData = req.body;
  const { customerName, contactDetails, waiverCompletionTime } = waiverData;

  const newConsultation = new Consultation({
    customerName,
    contactDetails,
    waiverCompletionTime,
    formLink: `https://smartwaiver.com/link-to-prefilled-form?customerId=${waiverData.customerId}`
  });

  await newConsultation.save();
  res.status(200).send('Consultation added to queue.');
});

// API to get consultations
app.get('/api/consultations', async (req, res) => {
  const consultations = await Consultation.find();
  res.json(consultations);
});

// API to update consultation status
app.post('/api/consultations/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  await Consultation.findByIdAndUpdate(id, { status });
  res.status(200).send('Status updated.');
});

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../frontend/build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
