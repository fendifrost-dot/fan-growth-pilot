import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

type Status = "loading" | "ok" | "already" | "missing" | "error";

const Unsubscribe: React.FC = () => {
  const [params] = useSearchParams();
  const token = params.get("t") || params.get("token") || "";
  const [status, setStatus] = useState<Status>("loading");
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    if (!token) { setStatus("missing"); return; }
    (async () => {
      const { data, error } = await supabase.rpc("unsubscribe_by_token", { p_token: token });
      if (error) { setStatus("error"); return; }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.email) { setStatus("missing"); return; }
      setEmail(row.email);
      setStatus(row.already_unsubscribed ? "already" : "ok");
    })();
  }, [token]);

  const headline =
    status === "loading" ? "One moment…"
    : status === "ok"      ? "You're unsubscribed."
    : status === "already" ? "Already unsubscribed."
    : status === "missing" ? "Link expired."
    :                        "Something went wrong.";

  const sub =
    status === "loading" ? ""
    : status === "ok" || status === "already"
      ? (email ? `${email} won't receive emails from Fendi Frost anymore.` : "You won't receive emails from Fendi Frost anymore.")
      : status === "missing"
        ? "This unsubscribe link is no longer valid. If you keep receiving emails, reply to the last one and we'll handle it manually."
        : "Please try again. If the problem persists, reply to the email and we'll take you off the list manually.";

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex items-center justify-center p-6">
      <div className="bg-white rounded shadow-sm max-w-md w-full p-12 text-center">
        <h1 className="text-xl font-medium mb-3 tracking-tight">{headline}</h1>
        {sub && <p className="text-sm text-neutral-600 leading-relaxed mb-8">{sub}</p>}
        <div className="text-[10px] tracking-[0.15em] uppercase text-neutral-400">Fendi Frost · fendifrost.com</div>
      </div>
    </div>
  );
};

export default Unsubscribe;
