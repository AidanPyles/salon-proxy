require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function generateCode() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

function isSalonOpen(salon) {
  const timezone = salon.timezone || "America/Los_Angeles";
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);

  const weekdayText = parts.find((p) => p.type === "weekday").value;
  const hour = parts.find((p) => p.type === "hour").value;
  const minute = parts.find((p) => p.type === "minute").value;

  const dayMap = {
    Sun: "0",
    Mon: "1",
    Tue: "2",
    Wed: "3",
    Thu: "4",
    Fri: "5",
    Sat: "6",
  };

  const today = dayMap[weekdayText];
  const currentTime = `${hour}:${minute}`;
  const openDays = (salon.open_days || "").split(",");

  if (!openDays.includes(today)) return false;

  return currentTime >= salon.open_time && currentTime <= salon.close_time;
}

app.get("/", (req, res) => {
  res.send("Salon proxy server is running");
});

app.post("/sms-webhook", async (req, res) => {
  console.log("SMS WEBHOOK HIT:", req.body);

  const from = req.body.From;
  const to = req.body.To;
  const body = (req.body.Body || "").trim();

  try {
    const { data: salon, error: salonError } = await supabase
      .from("salons")
      .select("*")
      .eq("twilio_number", to)
      .single();

    if (salonError || !salon) {
      console.error("Salon lookup error:", salonError);
      return res.send("");
    }

    const owner = salon.owner_phone;

    if (from === owner) {
      const match = body.match(/^@(\d{5})\s+([\s\S]+)/);

      if (!match) {
        await twilioClient.messages.create({
          from: to,
          to: owner,
          body: "Use: @12345 your reply",
        });
        return res.send("");
      }

      const code = match[1];
      const reply = match[2];

      const { data: convo, error: convoError } = await supabase
        .from("conversations")
        .select("*")
        .eq("salon_id", salon.id)
        .eq("thread_code", code)
        .eq("status", "open")
        .single();

      if (convoError || !convo) {
        await twilioClient.messages.create({
          from: to,
          to: owner,
          body: "Invalid code",
        });
        return res.send("");
      }

      await twilioClient.messages.create({
        from: to,
        to: convo.customer_number,
        body: reply,
      });

      await supabase
        .from("conversations")
        .update({ last_owner_reply_at: new Date().toISOString() })
        .eq("id", convo.id);

      return res.send("");
    }

    let { data: convo, error: convoLookupError } = await supabase
      .from("conversations")
      .select("*")
      .eq("salon_id", salon.id)
      .eq("customer_number", from)
      .eq("status", "open")
      .maybeSingle();

    if (convoLookupError) {
      console.error("Conversation lookup error:", convoLookupError);
      return res.send("");
    }

    if (!convo) {
      const code = generateCode();

      const { data, error: insertError } = await supabase
        .from("conversations")
        .insert({
          salon_id: salon.id,
          customer_number: from,
          thread_code: code,
          status: "open",
          last_customer_message_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError || !data) {
        console.error("Conversation insert error:", insertError);
        return res.send("");
      }

      convo = data;
    } else {
      await supabase
        .from("conversations")
        .update({ last_customer_message_at: new Date().toISOString() })
        .eq("id", convo.id);
    }

    await twilioClient.messages.create({
      from: to,
      to: owner,
      body:
        `[AUTO] ${salon.business_name} new message from ${from}\n` +
        `Reply: @${convo.thread_code} your message\n\n` +
        body,
    });

    return res.send("");
  } catch (err) {
    console.error("Server error:", err);
    return res.send("");
  }
});

app.post("/voice-webhook", async (req, res) => {
  console.log("VOICE WEBHOOK HIT:", req.body);

  const from = req.body.From;
  const to = req.body.To;

  try {
    const { data: salon, error: salonError } = await supabase
      .from("salons")
      .select("*")
      .eq("twilio_number", to)
      .single();

    if (salonError || !salon) {
      console.error("Voice salon lookup error:", salonError);
      return res.type("text/xml").send("<Response></Response>");
    }

    const VoiceResponse = twilio.twiml.VoiceResponse;

    if (!isSalonOpen(salon)) {
      await twilioClient.messages.create({
        from: to,
        to: from,
        body:
          salon.closed_message ||
          "Hi! Thanks for calling. We’re currently closed, but we’ll get back to you soon. Reply STOP to opt out.",
      });

      const response = new VoiceResponse();
      response.say("We are currently closed. We just sent you a text message.");
      return res.type("text/xml").send(response.toString());
    }

    const response = new VoiceResponse();

    const dial = response.dial({
      timeout: 8,
      action: `https://salon-proxy.onrender.com/call-status?from=${encodeURIComponent(
        from
      )}&to=${encodeURIComponent(to)}`,
      method: "POST",
    });

    dial.number(salon.owner_phone);

    return res.type("text/xml").send(response.toString());
  } catch (err) {
    console.error("Voice webhook error:", err);
    return res.type("text/xml").send("<Response></Response>");
  }
});

app.post("/call-status", async (req, res) => {
  console.log("CALL STATUS HIT:", req.body);

  const from = req.query.from;
  const to = req.query.to;
  const dialStatus = req.body.DialCallStatus;

  try {
    if (!["no-answer", "busy", "failed", "canceled"].includes(dialStatus)) {
      console.log("Call was handled. No missed-call text sent.");
      return res.type("text/xml").send("<Response></Response>");
    }

    const { data: salon, error: salonError } = await supabase
      .from("salons")
      .select("*")
      .eq("twilio_number", to)
      .single();

    if (salonError || !salon) {
      console.error("Call status salon lookup error:", salonError);
      return res.type("text/xml").send("<Response></Response>");
    }

    await twilioClient.messages.create({
      from: to,
      to: from,
      body:
        salon.open_message ||
        "Hi! Sorry we missed your call. How can we help? Reply STOP to opt out.",
    });

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say("Sorry we missed your call. We just sent you a text message.");

    return res.type("text/xml").send(response.toString());
  } catch (err) {
    console.error("Call status error:", err);
    return res.type("text/xml").send("<Response></Response>");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});