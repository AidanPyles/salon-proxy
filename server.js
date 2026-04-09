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

app.post("/sms-webhook", async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  const body = (req.body.Body || "").trim();

  try {
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("*")
      .eq("twilio_number", to)
      .single();

    if (clientError || !client) {
      console.error("Client lookup error:", clientError);
      return res.send("");
    }

    const owner = client.owner_number;

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
        .eq("client_id", client.id)
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
      .eq("client_id", client.id)
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
          client_id: client.id,
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
        `[AUTO] ${client.salon_name} new message from ${from}\n` +
        `Reply: @${convo.thread_code} your message\n\n` +
        body,
    });

    return res.send("");
  } catch (err) {
    console.error("Server error:", err);
    return res.send("");
  }
});

app.listen(process.env.PORT, () => {
  console.log("Server running");
});