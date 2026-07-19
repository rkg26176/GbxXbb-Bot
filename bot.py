import os
import logging
import urllib.request
import urllib.parse
import json
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- GLOBAL SYSTEM LAYERS CONFIG ---
REQUIRED_TARGETS = [
    -1003332858806, -1003630519339, -1003197501531, -1003862251237
]
TARGET_LINKS = {
    -1003332858806: "https://t.me/+6ByfGDRBKgsxMjZl",   
    -1003630519339: "https://t.me/+OWrCoeF-JutmNjg1",   
    -1003197501531: "https://t.me/+f2mWfDs6EUIxYTBl",   
    -1003862251237: "https://t.me/+O_-kEF2f5f1kMjdl"            
}
TARGET_LABELS = {
    -1003332858806: "📢 Join GBX LOOT", 
    -1003630519339: "📢 Join GBX EARN",
    -1003197501531: "📢 Join GBX Zone", 
    -1003862251237: "💬 Join Group Chat (GC)"
}

bot_app = None

# MASTER 5-BUTTON KEYBOARD ENGINE
def load_dashboard_menu():
    MINI_APP_URL = os.getenv("RENDER_EXTERNAL_URL", "https://gbxxbb-bot.onrender.com")
    return ReplyKeyboardMarkup([
        [KeyboardButton("📱 My Accounts"), KeyboardButton("➕ New Login")],
        [KeyboardButton("💰 Wallet"), KeyboardButton("🛠️ Customer Care")],
        [KeyboardButton("🛒 Live BigBasket Store", web_app=WebAppInfo(url=MINI_APP_URL))]
    ], resize_keyboard=True)

async def verify_user_membership(user_id: int) -> bool:
    global bot_app
    if not bot_app: return False
    for target in REQUIRED_TARGETS:
        try:
            member = await bot_app.bot.get_chat_member(chat_id=target, user_id=user_id)
            if member.status in ['left', 'kicked']: return False
        except TelegramError: return False
    return True

async def show_force_join_menu(update: Update):
    buttons = []
    for target in REQUIRED_TARGETS:
        buttons.append([InlineKeyboardButton(text=TARGET_LABELS[target], url=TARGET_LINKS[target])])
    buttons.append([InlineKeyboardButton(text="🔄 Verify / Check Access", callback_data="verify_all_joins")])
    
    alert_text = "⚠️ **Access Denied!**\n\nBot features use karne ke liye channels aur GC join karein."
    if update.message: 
        await update.message.reply_text(alert_text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")
    elif update.callback_query: 
        await update.callback_query.message.reply_text(alert_text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await verify_user_membership(update.effective_user.id):
        await show_force_join_menu(update)
        return
    await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def verify_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if await verify_user_membership(query.from_user.id):
        await query.message.delete()
        # FIXED: Yahan ab strictly naya 5-button master keyboard push hoga
        await query.message.reply_text("✅ Access Granted!", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
    else:
        await query.answer(text="❌ Saare channels join nahi kiye!", show_alert=True)

# KEYBOARD ROUTER PROCESSING PANEL
async def handle_text_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_text = update.message.text
    
    # 1. Customer Care Link Button Handler
    if user_text == "🛠️ Customer Care":
        support_keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton(text="💬 Open Support Bot", url="https://t.me/gbx_support_bot")]
        ])
        await update.message.reply_text(
            "🙋‍♂️ **GBX Official Support**\n\nAgar aapko kisi bhi tarah ki sahayata chahiye, toh niche diye button par click karke hamare customer care support se contact karein.",
            reply_markup=support_keyboard,
            parse_mode="Markdown"
        )
        return
        
    # 2. Wallet Trigger
    elif user_text == "💰 Wallet":
        await update.message.reply_text("💳 **Your Wallet Balance:** `₹0.00` \n\n*(Payment dynamic operations panel)*", parse_mode="Markdown")
        return

    # 3. Operations Buttons Fallback Display
    elif user_text in ["📱 My Accounts", "➕ New Login"]:
        await update.message.reply_text(f"🚧 **{user_text}** functionality structure initialization pending.", parse_mode="Markdown")
        return

    # Default fallback to keep keyboard up
    await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def web_app_data_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw_payload_wire = update.effective_message.web_app_data.data
    try:
        segmented_nodes = raw_payload_wire.split("^")
        extracted_tx_code = segmented_nodes[0].split(":")[1]
        extracted_final_bill = segmented_nodes[1].split(":")[1]
        extracted_location = segmented_nodes[2].split(":")[1]
        
        compiled_receipt = "🎉 **Order Placed Successfully!**\n"
        compiled_receipt += "────────────────────────\n"
        compiled_receipt += f"🆔 **Order ID:** `{extracted_tx_code}`\n"
        compiled_receipt += f"💵 **Total Payment Due:** **{extracted_final_bill}**\n"
        compiled_receipt += f"📍 **User Destination:**\n`{extracted_location}`\n"
        compiled_receipt += "────────────────────────\n"
        compiled_receipt += "🚚 *Status: Dispatch pending account clearance.*"
        
        await update.message.reply_text(compiled_receipt, parse_mode="Markdown")
    except Exception as data_err:
        await update.message.reply_text(f"🎉 **Order Placed Successfully!**\n\n📦 *Payload:* {raw_payload_wire}")

# --- FASTAPI SERVER MODULE ---
api_app = FastAPI()

@api_app.get("/")
def home(): 
    return FileResponse("index.html")

@api_app.get("/api/search")
def proxy_search(query: str = "milk", page: int = 1):
    api_key = os.getenv("PARSE_BOT_API_KEY")
    if not api_key: return {"products": []}
    encoded_query = urllib.parse.quote(query.lower().strip())
    url = f"https://api.parse.bot/scraper/1d9ca2c5-176c-4bc0-9cf3-db9056850958/search_products?page={page}&query={encoded_query}"
    req = urllib.request.Request(url)
    req.add_header("X-API-Key", api_key)
    try:
        with urllib.request.urlopen(req, timeout=8.0) as response:
            raw_data = json.loads(response.read().decode('utf-8'))
            extracted_items = []
            if isinstance(raw_data, list): extracted_items = raw_data
            elif isinstance(raw_data, dict):
                for key in ["results", "products", "data", "items"]:
                    if isinstance(raw_data.get(key), list) and len(raw_data.get(key)) > 0:
                        extracted_items = raw_data[key]
                        break
            formatted_out = []
            for node in extracted_items[:15]:
                title = node.get("title") or node.get("name") or "BigBasket Item"
                price = node.get("price") or node.get("sale_price") or 45
                image = node.get("image") or node.get("image_url") or ""
                formatted_out.append({"title": title, "price": int(price), "image": image})
            return {"products": formatted_out}
    except Exception:
        return {"products": []}

@api_app.on_event("startup")
async def init_webhook_mode():
    global bot_app
    TOKEN = os.getenv("BOT_TOKEN")
    URL = os.getenv("RENDER_EXTERNAL_URL")
    if not TOKEN or not URL: return

    bot_app = Application.builder().token(TOKEN).connect_timeout(30.0).read_timeout(30.0).updater(None).build()
    bot_app.add_handler(CommandHandler("start", start))
    bot_app.add_handler(CallbackQueryHandler(verify_callback_handler, pattern="verify_all_joins"))
    bot_app.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, web_app_data_handler))
    bot_app.add_handler(filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND, handle_text_messages)
    
    await bot_app.initialize()
    await bot_app.start()
    await bot_app.bot.set_webhook(url=f"{URL}/webhook")

@api_app.post("/webhook")
async def receive_telegram_update(request: Request):
    global bot_app
    if bot_app:
        data = await request.json()
        await bot_app.process_update(Update.de_json(data, bot_app.bot))
    return Response(status_code=200)

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(api_app, host="0.0.0.0", port=port)
    
