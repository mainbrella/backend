-- NULL on historical phone calls means PSTN. Browser/text calls have no transport.
ALTER TABLE voice_calls ADD COLUMN phone_transport TEXT
  CHECK (phone_transport IN ('pstn', 'sip'));
