// services/logger.js

const { createLogger, format, transports } = require('winston');
const path = require('path');

// Define log format
const logFormat = format.printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

// Create logger
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new transports.File({ filename: path.resolve(__dirname, '../logs/error.log'), level: 'error' }),
    new transports.File({ filename: path.resolve(__dirname, '../logs/combined.log') }),
  ],
});

// If we're not in production then **ALSO** log to the `console`
if (process.env.NODE_ENV !== 'production') {
  logger.add(new transports.Console({
    format: format.combine(
      format.colorize(),
      format.simple()
    ),
  }));
}

module.exports = logger;
