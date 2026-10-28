// firstOwner.js — the login an empty database starts with.
//
// When the database has no accounts at all (a new one, after the free Render
// database expired), the server creates the shop and this owner on start, so
// there is always a way in. It does nothing once any account exists: it can
// never overwrite or reset a real one.
//
// Only the bcrypt hash is kept here, never the password: the password cannot
// be recovered from it, so the repository stays safe even if it is public.
// The owner was given the password separately; change it after the first
// login under Kontod → Minu parool.

module.exports = {
  email: "admin@fibarbers.ee",
  name: "Fi Barbershop admin",
  passwordHash: "$2a$12$EV4icO96nb65BS85jILUcubzqFeTYvwmIkqlLYd/MA9dU.uwujVVy",
};
