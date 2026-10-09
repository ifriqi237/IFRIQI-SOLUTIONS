// F-13 (audit pré-prod) : version figée explicitement, comme dans
// frontend-integration/supabase-client.js — jamais "@2" flottant.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Client "service_role" : utilisé UNIQUEMENT à l'intérieur des Edge Functions, jamais exposé
// au navigateur. Il contourne RLS par conception — c'est lui qui a le droit d'écrire dans
// orders/payments/commissions, pas le client.
export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// Client "scopé utilisateur" : respecte RLS, pour vérifier qui appelle (à partir du JWT
// envoyé par le front dans l'en-tête Authorization).
export function userClient(authHeader: string | null) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader ?? "" } } },
  );
}
