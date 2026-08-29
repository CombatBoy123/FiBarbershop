// auth.js — password hashing, JWT signing and the requireAuth middleware.
// Standard Express/JWT shape: hash on write, verify on read, one middleware.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET is not set. Copy .env.example to .env and set a long random JWT_SECRET before starting the server."
  );
}
const TOKEN_TTL = "30d";

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Express middleware: reads "Authorization: Bearer <token>", attaches req.userId.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Palun logi sisse." });
  req.userId = payload.sub;
  req.userEmail = payload.email;
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth };
