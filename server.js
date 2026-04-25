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

    const twiml = `
      <Response>
        <Dial 
          timeout="15"
          action="/call-status?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}"
          method="POST">
          ${salon.owner_phone}
        </Dial>
      </Response>
    `;

    return res.type("text/xml").send(twiml);
  } catch (err) {
    console.error("Voice webhook error:", err);
    return res.type("text/xml").send("<Response></Response>");
  }
});

app.post("/call-status", async (req, res) => {
  console.log("CALL STATUS HIT:", req.body);

  const from = req.query.from; // original caller
  const to = req.query.to;     // Twilio number
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

    return res.type("text/xml").send(`
      <Response>
        <Say>Sorry we missed your call. We just sent you a text message.</Say>
      </Response>
    `);
  } catch (err) {
    console.error("Call status error:", err);
    return res.type("text/xml").send("<Response></Response>");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});