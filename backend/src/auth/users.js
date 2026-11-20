/**
 * User lookups shared by login, the current-user endpoint and (from stage 3)
 * the role middleware. IDs are returned as decimal strings, matching how pg
 * returns bigint and how the stock API reports IDs.
 */

const USER_COLUMNS = 'id::text AS id, name, email, role, password_hash, disabled_at';

/** Email lookup is case-insensitive, matching the users_email_unique index. */
export async function findUserByEmail(db, email) {
  const result = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`, [email]);
  return result.rows[0];
}

export async function findUserById(db, id) {
  if (!/^[1-9]\d{0,18}$/.test(String(id))) return undefined;
  const result = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [String(id)]);
  return result.rows[0];
}

/** The only user fields ever sent to clients. */
export function toPublicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}
