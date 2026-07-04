#include "application.hpp"

extern "C" void app_main()
{
    scope::Application::instance().start();
}
