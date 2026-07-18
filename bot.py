import os
import logging
import asyncio
import uvicorn
from fastapi import FastAPI
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

# Logging setup
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# 1. Dummy Web Server Render ko ullu banane ke liye (Free Tier Trigger)
api_app = FastAPI()

@api_app.get("/")
async def home():
    return {"status": "GbxXbb Bot is running perfectly!"}

# 2. Telegram Bot Logic
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [KeyboardButton("📱 My Accounts"), KeyboardButton("🏠 Home")],
        [KeyboardButton("💰 Wallet"), KeyboardButton("➕ New Login")]
    ]
    reply_markup = ReplyKeyboardMarkup(keyboard, resize_keyboard=True)
    await update.message.reply_text(
        "Welcome to GbxXbb Dashboard! Please select an option:",
        reply_markup=reply_markup
    )

async def handle_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    if text == "📱 My Accounts":
        await update.message.reply_text("Aapke saved accounts ki list yahan show hogi...")
    elif text == "💰 Wallet":
        await update.message.reply_text("💵 Aapka current balance: ₹0.00\n\nPaise add karne ke liye jald hi QR system update hoga.")
    elif text == "➕ New Login":
        await update.message.reply_text("Apna generic phone number enter karein session track karne ke liye:")
    elif text == "🏠 Home":
        await update.message.reply_text("Aap main menu par hain. Niche diye gaye buttons use karein.")

# 3. Dono (Bot + Web Server) ko sath me chalane ka logic
async def run_bot():
    TOKEN = os.getenv("BOT_TOKEN")
    if not TOKEN:
        print("ERROR: BOT_TOKEN variable nahi mila!")
        return

    bot_app = Application.builder().token(TOKEN).build()
    bot_app.add_handler(CommandHandler("start", start))
    bot_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_menu))
    
    # Bot ko background me initialize aur start karna
    await bot_app.initialize()
    await bot_app.start()
    await bot_app.updater.start_polling()
    
    # Jab tak app chal rahi hai loop ko zinda rakhna
    while True:
        await asyncio.sleep(3600)

@api_app.on_event("startup")
async def startup_event():
    # Asynchronous tarike se bot ko background me chala dena
    asyncio.create_task(run_bot())

if __name__ == "__main__":
    # Render automatically PORT environment variable deta hai
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(api_app, host="0.0.0.0", port=port)
    
