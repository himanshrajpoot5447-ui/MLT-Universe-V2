// lib/auth.js — JWT middleware for Vercel API routes
import jwt from 'jsonwebtoken';
import { queryOne } from './db.js';

export function getToken(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

export async function requireAuth(req) {
  const token = getToken(req);
  if (!token) throw { status: 401, message: 'No token provided' };

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw { status: 401, message: 'Invalid or expired token' };
  }

  const user = await queryOne('SELECT * FROM users WHERE id = $1', [decoded.id]);
  if (!user) throw { status: 401, message: 'User not found' };
  if (user.status === 'inactive') throw { status: 403, message: 'Account is inactive' };
  return user;
}

export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) {
    throw { status: 403, message: `Access denied. Required: ${roles.join(', ')}` };
  }
}

export function isAdmin(user) {
  return ['master', 'admin'].includes(user.role);
}

export function isMaster(user) {
  return user.role === 'master';
}
