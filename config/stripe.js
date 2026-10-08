import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Falta STRIPE_SECRET_KEY en las variables de entorno");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);