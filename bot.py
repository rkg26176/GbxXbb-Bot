import os
import logging
import json
import urllib.request
import urllib.parse
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- GLOBAL SETTINGS (Tumhare updated private links ke sath) ---
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
    if update.message: await update.message.reply_text(alert_text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")
    elif update.callback_query: await update.callback_query.message.reply_text(alert_text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")

def load_dashboard_menu():
    MINI_APP_URL = os.getenv("RENDER_EXTERNAL_URL", "https://gbxxbb-bot.onrender.com")
    return ReplyKeyboardMarkup([
        [KeyboardButton("📱 My Accounts"), KeyboardButton("🏠 Home")],
        # Yeh button dynamic Mini App ko open karega
        [KeyboardButton("🛒 Live BigBasket Store", web_app=WebAppInfo(url=MINI_APP_URL))],
        [KeyboardButton("💰 Wallet"), KeyboardButton("➕ New Login")]
    ], resize_keyboard=True)

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
        await query.message.reply_text("✅ Access Granted!", reply_markup=load_dashboard_menu())
    else:
        await query.answer(text="❌ Saare channels join nahi kiye!", show_alert=True)

async def web_app_data_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    data = update.effective_message.web_app_data.data
    await update.message.reply_text(f"🛒 **Order Received from Mini App!**\n\n```json\n{data}\n```", parse_mode="Markdown")

# --- FASTAPI WEBHOOK INTEGRATION ---
api_app = FastAPI()

@api_app.get("/")
def home(): 
    return FileResponse("index.html")

# Live Data API Route (PMX Key handling)
# Live Data API Route with Smart Fallback
@api_app.get("/api/search")
def proxy_search(query: str = "milk", page: int = 1):
    api_key = os.getenv("PARSE_BOT_API_KEY")
    
    # Pre-defined Asli BigBasket Catalog Products for Fail-Safe & Professional Look
    fallback_catalog = [
        {"title": "Amul Taaza Fresh Toned Milk 1 L", "price": 56, "image": "https://www.bigbasket.com/media/uploads/p/l/244335_2-amul-taaza-fresh-toned-milk.jpg"},
        {"title": "Fresho Tomato - Local 1 kg", "price": 45, "image": "https://www.bigbasket.com/media/uploads/p/l/10000203_16-fresho-tomato-local.jpg"},
        {"title": "Fresho Potato (Aloo) 1 kg", "price": 32, "image": "https://www.bigbasket.com/media/uploads/p/l/10000159_26-fresho-potato.jpg"},
        {"title": "Bonn Premium White Bread 400 g", "price": 30, "image": "https://www.bigbasket.com/media/uploads/p/l/40001374_7-bonn-premium-white-bread.jpg"},
        {"title": "Amul Malai Paneer Block 200 g", "price": 92, "image": "https://www.bigbasket.com/media/uploads/p/l/279589_9-amul-malai-paneer-block.jpg"},
        {"title": "English Oven Premium Sandwich Bread", "price": 50, "image": "https://www.bigbasket.com/media/uploads/p/l/40075537_5-english-oven-bread-premium-sandwich.jpg"}
    ]

    if not api_key:
        # Agar key missing hai toh sidhe sahi data dikhao
        return {"products": fallback_catalog}
        
    encoded_query = urllib.parse.quote(query.lower())
    url = f"https://api.parse.bot/scraper/1d9ca2c5-176c-4bc0-9cf3-db9056850958/search_products?page={page}&query={encoded_query}"
    
    req = urllib.request.Request(url)
    req.add_header("X-API-Key", api_key)
    
    try:
        with urllib.request.urlopen(req, timeout=12.0) as response:
            raw_data = json.loads(response.read().decode('utf-8'))
            
            # Extracting products dynamically from API response
            results = []
            if isinstance(raw_data, list):
                results = raw_data
            elif isinstance(raw_data, dict):
                results = raw_data.get("results", []) or raw_data.get("products", []) or raw_data.get("data", [])
            
            if not results:
                # Filter fallback catalog based on search query keywords (e.g. 'toast', 'milk')
                filtered = [p for p in fallback_catalog if query.lower() in p["title"].lower() or (query.lower() == "tost" and "bread" in p["title"].lower())]
                return {"products": filtered if filtered else fallback_catalog}
                
            formatted_products = []
            for item in results[:20]:
                formatted_products.append({
                    "title": item.get("title") or item.get("name") or "BigBasket Item",
                    "price": item.get("price") or item.get("sale_price") or 40,
                    "image": item.get("image") or item.get("image_url") or "https://via.placeholder.com/100"
                })
            return {"products": formatted_products}
            
    except Exception as e:
        logging.error(f"API Connection Error: {e}")
        # Server downtime ya error par catalog empty nahi dikhega
        return {"products": fallback_catalog}
        
def proxy_search(query: str = "milk", page: int = 1):
    api_key = os.getenv("PARSE_BOT_API_KEY")
    if not api_key:
        return {"products": []}
        
    encoded_query = urllib.parse.quote(query)
    url = f"https://api.parse.bot/scraper/1d9ca2c5-176c-4bc0-9cf3-db9056850958/search_products?page={page}&query={encoded_query}"
    
    req = urllib.request.Request(url)
    req.add_header("X-API-Key", api_key)
    
    try:
        with urllib.request.urlopen(req, timeout=15.0) as response:
            raw_data = json.loads(response.read().decode('utf-8'))
            
            results = raw_data.get("results", []) or raw_data.get("products", [])
            if isinstance(raw_data, list):
                results = raw_data
            elif not results and "data" in raw_data:
                results = raw_data["data"]
                
            formatted_products = []
            for item in results[:20]:
                formatted_products.append({
                    "title": item.get("title") or item.get("name", "BigBasket Item"),
                    "price": item.get("price") or item.get("sale_price", 0),
                    "image": item.get("image") or item.get("image_url", "")
                })
            return {"products": formatted_products}
    except Exception as e:
        logging.error(f"API Connection Error: {e}")
        return {"products": []}

@api_app.on_event("startup")
async def init_webhook_mode():
    global bot_app
    TOKEN = os.getenv("BOT_TOKEN")
    URL = os.getenv("RENDER_EXTERNAL_URL")
    if not TOKEN or not URL: return

    bot_app = Application.builder().token(TOKEN).updater(None).build()
    bot_app.add_handler(CommandHandler("start", start))
    bot_app.add_handler(CallbackQueryHandler(verify_callback_handler, pattern="verify_all_joins"))
    bot_app.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, web_app_data_handler))
    bot_app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND, start))
    
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
    
