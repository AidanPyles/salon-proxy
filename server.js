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

async function hasRecentAutomatedOutboundMessage({
  salon,
  customerNumber,
  message,
  minutes = 5,
}) {
  const cutoffTime = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("message_logs")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("direction", "outbound")
    .eq("from_number", salon.twilio_number)
    .eq("to_number", customerNumber)
    .eq("body", message)
    .gte("created_at", cutoffTime)
    .limit(1);

  if (error) {
    console.error("Duplicate check error:", error);
    return false;
  }

  return data && data.length > 0;
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

async function sendAndLogAutomatedMessage({ salon, customerNumber, message }) {
  const alreadySentRecently = await hasRecentAutomatedOutboundMessage({
    salon,
    customerNumber,
    message,
    minutes: 5,
  });

  if (alreadySentRecently) {
    console.log(
      `Skipped duplicate automated message to ${customerNumber}. Already sent in the last 5 minutes.`
    );

    return {
      sent: false,
      skippedDuplicate: true,
    };
  }

  await twilioClient.messages.create({
    from: salon.twilio_number,
    to: customerNumber,
    body: message,
  });

  await logAutomatedOutboundMessage({
    salon,
    customerNumber,
    message,
  });

  return {
    sent: true,
    skippedDuplicate: false,
  };
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

  const numMedia = Number(req.body.NumMedia || 0);
  const mediaUrls = [];
  const mediaContentTypes = [];

  for (let i = 0; i < numMedia; i++) {
    if (req.body[`MediaUrl${i}`]) {
      mediaUrls.push(req.body[`MediaUrl${i}`]);
      mediaContentTypes.push(req.body[`MediaContentType${i}`] || "");
    }
  }

  const hasMedia = mediaUrls.length > 0;
  const displayBody = body || (hasMedia ? "[Image]" : "");
  const messageType = hasMedia ? "media" : "text";

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
          last_message: displayBody,
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
          last_message: displayBody,
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
      body: displayBody,
      media_urls: mediaUrls,
      media_content_types: mediaContentTypes,
      message_type: messageType,
      created_at: now,
    });

    await twilioClient.messages.create({
      from: to,
      to: owner,
      body:
        `[AUTO] ${salon.business_name} new message from ${from}\n` +
        `Reply: @${convo.thread_code} your message\n\n` +
        displayBody,
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

      await sendAndLogAutomatedMessage({
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

    await sendAndLogAutomatedMessage({
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

app.get("/media-proxy", async (req, res) => {
  try {
    const mediaUrl = req.query.url;

    if (!mediaUrl) {
      return res.status(400).send("Missing media URL");
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(mediaUrl);
    } catch (error) {
      return res.status(400).send("Invalid media URL");
    }

    const allowedHosts = ["api.twilio.com", "mcs.us1.twilio.com"];

    if (!allowedHosts.includes(parsedUrl.hostname)) {
      return res.status(403).send("Media host not allowed");
    }

    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const mediaResponse = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    if (!mediaResponse.ok) {
      console.error("MEDIA PROXY ERROR:", mediaResponse.status);
      return res.status(mediaResponse.status).send("Failed to load media");
    }

    const contentType =
      mediaResponse.headers.get("content-type") || "application/octet-stream";

    const arrayBuffer = await mediaResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");

    return res.send(buffer);
  } catch (error) {
    console.error("MEDIA PROXY SERVER ERROR:", error);
    return res.status(500).send("Media proxy error");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});