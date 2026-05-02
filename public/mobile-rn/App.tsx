import React, { useState } from "react";
import { View, TextInput, Button, Text, ScrollView } from "react-native";

const API_BASE = "http://YOUR_SERVER:8000";

export default function App() {
  const [message, setMessage] = useState("");
  const [chat, setChat] = useState<{ role: "user" | "ai"; text: string }[]>([]);

  const sendMessage = async () => {
    if (!message.trim()) return;
    const userMsg = message.trim();
    setChat((prev) => [...prev, { role: "user", text: userMsg }]);
    setMessage("");

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg, top_k: 5 }),
      });
      const data = await res.json();
      setChat((prev) => [...prev, { role: "ai", text: data.reply || "暫時沒有回覆" }]);
    } catch (e) {
      setChat((prev) => [...prev, { role: "ai", text: "連線失敗，請檢查伺服器設定。" }]);
    }
  };

  return (
    <View style={{ flex: 1, padding: 20, backgroundColor: "#0F0F0F" }}>
      <ScrollView style={{ flex: 1, marginBottom: 12 }}>
        {chat.map((c, i) => (
          <Text key={i} style={{ color: c.role === "user" ? "#fff" : "#D4AF37", marginBottom: 8 }}>
            {c.text}
          </Text>
        ))}
      </ScrollView>
      <TextInput
        value={message}
        onChangeText={setMessage}
        placeholder="輸入你現在的社交難題..."
        placeholderTextColor="#888"
        style={{
          borderColor: "#D4AF37",
          borderWidth: 1,
          color: "#fff",
          marginBottom: 10,
          padding: 10,
          borderRadius: 8,
        }}
      />
      <Button title="Send" onPress={sendMessage} />
    </View>
  );
}
