require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://pyles-inbox.vercel.app",
      "https://pyles-inbox.vercel.app/",
      "https://inbox.pylesautomation.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
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

async function getOrCreateConversation(salon, customerNumber) {
  let { data: convo, error: convoLookupError } = await supabase
    .from("conversations")
    .select("*")
    .eq("salon_id", salon.id)
    .eq("customer_number", customerNumber)
    .eq("status", "open")
    .maybeSingle();

  if (convoLookupError) {
    console.error("Conversation lookup error:", convoLookupError);
    return null;
  }

  if (convo) return convo;

  const code = generateCode();
  const now = new Date().toISOString();

  const { data, error: insertError } = await supabase
    .from("conversations")
    .insert({
      salon_id: salon.id,
      customer_number: customerNumber,
      thread_code: code,
      status: "open",
      unread_count: 0,
      last_activity_at: now,
    })
    .select()
    .single();

  if (insertError || !data) {
    console.error("Conversation insert error:", insertError);
    return null;
  }

  return data;
}

async function logAutomatedOutboundMessage({ salon, customerNumber, message }) {
  const now = new Date().toISOString();

  const convo = await getOrCreateConversation(salon, customerNumber);

  if (!convo) {
    console.error("Could not create/find conversation for automated message.");
    return null;
  }

  const { error: logError } = await supabase.from("message_logs").insert({
    salon_id: salon.id,
    conversation_id: convo.id,
    direction: "outbound",
    from_number: salon.twilio_number,
    to_number: customerNumber,
    body: message,
    created_at: now,
  });

  if (logError) {
    console.error("Automated message log error:", logError);
  }

  const { data: updatedConvo, error: updateError } = await supabase
    .from("conversations")
    .update({
      last_owner_reply_at: now,
      last_activity_at: now,
      last_message: message,
    })
    .eq("id", convo.id)
    .select()
    .single();

  if (updateError) {
    console.error("Automated conversation update error:", updateError);
    return convo;
  }

  return updatedConvo;
}

app.get("/", (req, res) => {
  res.send("Salon proxy server is running");
});

app.post("/dashboard-send-message", async (req, res) => {
  console.log("DASHBOARD SEND HIT:", req.body);

  const { salon_id, customer_number, message } = req.body;

  if (!salon_id || !customer_number || !message || !message.trim()) {
    return res.status(400).json({
      success: false,
      error: "Missing salon_id, customer_number, or message",
    });
  }

  const trimmedMessage = message.trim();

  try {
    const { data: salon, error: salonError } = await supabase
      .from("salons")
      .select("*")
      .eq("id", salon_id)
      .single();

    if (salonError || !salon) {
      console.error("Salon lookup error:", salonError);
      return res.status(404).json({
        success: false,
        error: "Salon not found",
      });
    }

    const { data: convo, error: convoError } = await supabase
      .from("conversations")
      .select("*")
      .eq("salon_id", salon.id)
      .eq("customer_number", customer_number)
      .eq("status", "open")
      .single();

    if (convoError || !convo) {
      console.error("Dashboard conversation lookup error:", convoError);
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    const now = new Date().toISOString();

    await twilioClient.messages.create({
      from: salon.twilio_number,
      to: customer_number,
      body: trimmedMessage,
    });

    await supabase.from("message_logs").insert({
      salon_id: salon.id,
      conversation_id: convo.id,
      direction: "outbound",
      from_number: salon.twilio_number,
      to_number: customer_number,
      body: trimmedMessage,
      created_at: now,
    });

    await supabase
      .from("conversations")
      .update({
        last_owner_reply_at: now,
        last_activity_at: now,
        last_message: trimmedMessage,
      })
      .eq("id", convo.id);

    return res.json({
      success: true,
      message: "Message sent successfully",
    });
  } catch (err) {
    console.error("Dashboard send error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
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

    // OWNER REPLY FLOW
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
      const reply = match[2].trim();

      if (!reply) {
        await twilioClient.messages.create({
          from: to,
          to: owner,
          body: "Your reply cannot be empty.",
        });

        return res.send("");
      }

      const now = new Date().toISOString();

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

      await supabase.from("message_logs").insert({
        salon_id: salon.id,
        conversation_id: convo.id,
        direction: "outbound",
        from_number: to,
        to_number: convo.customer_number,
        body: reply,
        created_at: now,
      });

      await supabase
        .from("conversations")
        .update({
          last_owner_reply_at: now,
          last_activity_at: now,
          last_message: reply,
        })
        .eq("id", convo.id);

      return res.send("");
    }

    // CUSTOMER INBOUND MESSAGE FLOW
    const now = new Date().toISOString();

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
          unread_count: 1,
          last_message: body,
          last_customer_message_at: now,
          last_activity_at: now,
        })
        .select()
        .single();

      if (insertError || !data) {
        console.error("Conversation insert error:", insertError);
        return res.send("");
      }

      convo = data;
    } else {
      const newUnreadCount = (convo.unread_count || 0) + 1;

      const { data: updatedConvo, error: updateError } = await supabase
        .from("conversations")
        .update({
          unread_count: newUnreadCount,
          last_message: body,
          last_customer_message_at: now,
          last_activity_at: now,
        })
        .eq("id", convo.id)
        .select()
        .single();

      if (updateError) {
        console.error("Conversation unread update error:", updateError);
      } else {
        convo = updatedConvo;
      }
    }

    await supabase.from("message_logs").insert({
      salon_id: salon.id,
      conversation_id: convo.id,
      direction: "inbound",
      from_number: from,
      to_number: to,
      body,
      created_at: now,
    });

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
      const closedMessage =
        salon.closed_message ||
        "Hi! Thanks for calling. We’re currently closed, but we’ll get back to you soon. Reply STOP to opt out.";

      await twilioClient.messages.create({
        from: to,
        to: from,
        body: closedMessage,
      });

      await logAutomatedOutboundMessage({
        salon,
        customerNumber: from,
        message: closedMessage,
      });

      const response = new VoiceResponse();
      response.say("We are currently closed. We just sent you a text message.");

      return res.type("text/xml").send(response.toString());
    }

    const response = new VoiceResponse();

    const dial = response.dial({
      timeout: salon.ring_timeout_seconds || 10,
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

    const missedCallMessage =
      salon.open_message ||
      "Hi! Sorry we missed your call. How can we help? Reply STOP to opt out.";

    await twilioClient.messages.create({
      from: to,
      to: from,
      body: missedCallMessage,
    });

    await logAutomatedOutboundMessage({
      salon,
      customerNumber: from,
      message: missedCallMessage,
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