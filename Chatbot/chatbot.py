from groq import Groq
client = Groq(api_key="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")
while True:
    msg = input("You: ")
    if msg.lower() == "exit":
        break
    response = client.chat.completions.create(
         model="openai/gpt-oss-120b",
        messages=[{"role": "user", "content": msg}]
    )
    print("Bot:", response.choices[0].message.content)
